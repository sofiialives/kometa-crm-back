import { prisma } from '../../config/prisma.js'
import { ApiError } from '../../utils/ApiError.js'
import { assertAdmin, EMPLOYEE_ROLE, EMPLOYEE_SELECT } from './access.js'
import { validateScale, validateWorkLevels } from './engine.js'
import { assignmentsAt, getGlobalScale, getSettingsRow, getWorkLevels, PROFILE_INCLUDE } from './profiles.js'
import { employeeCard, eventTypeCard } from './shape.js'

/**
 * Раздел «Настройки» — только для админа.
 *
 * Здесь живёт всё, что в задании отдано на откуп владельцу: профили
 * должностей и их события, общая шкала премии и свои шкалы профилей,
 * уровни работы, лимит штрафа за просрочку, уведомления и назначение
 * профиля каждому сотруднику. Всё меняется без разработчика.
 *
 * Уже начисленные баллы при правках не пересчитываются: в каждой записи
 * журнала лежат свои баллы и название на момент начисления. А шкала,
 * уровни работы и профиль действуют на месяц целиком — поменяли долю
 * уровня, и текущий месяц сразу считается по новой. Итоги закрытых месяцев
 * зафиксирует закрытие месяца (этап 3): до него прошлые месяцы показываются
 * по текущим настройкам.
 */

const toCents = (dollars) => Math.round(Number(dollars) * 100)

const PRODUCT_KEY = 'client_product'

function profileView(profile, usage) {
  return {
    id: profile.id,
    title: profile.title,
    startBankCents: profile.startBankCents,
    customScale: profile.customScale,
    workHints: profile.workHints ?? {},
    conditionsUpdatedAt: profile.conditionsUpdatedAt,
    events: profile.eventTypes.map(eventTypeCard),
    scale: profile.prizeLevels.map((l) => ({ position: l.position, threshold: l.threshold, percent: l.percent })),
    assignedCount: usage?.assigned ?? 0,
    eventsCount: usage?.events ?? 0,
  }
}

/** Сколько сотрудников сейчас на профиле и сколько событий по нему записано. */
async function profileUsage() {
  const [current, events] = await Promise.all([
    assignmentsAt(
      (await prisma.user.findMany({ where: { role: EMPLOYEE_ROLE }, select: { id: true } })).map((u) => u.id),
    ),
    prisma.motivationEvent.groupBy({ by: ['profileId'], _count: { _all: true } }),
  ])
  const usage = new Map()
  for (const a of current.values()) {
    const u = usage.get(a.profileId) ?? { assigned: 0, events: 0 }
    u.assigned += 1
    usage.set(a.profileId, u)
  }
  for (const row of events) {
    if (!row.profileId) continue
    const u = usage.get(row.profileId) ?? { assigned: 0, events: 0 }
    u.events = row._count._all
    usage.set(row.profileId, u)
  }
  return usage
}

/** Всё содержимое «Настроек» одним ответом: экран небольшой, грузится целиком. */
export async function getSettings(actor) {
  assertAdmin(actor)
  const [profiles, globalScale, workLevels, settings, usage, users] = await Promise.all([
    prisma.motivationProfile.findMany({ include: PROFILE_INCLUDE, orderBy: { title: 'asc' } }),
    getGlobalScale(),
    getWorkLevels(),
    getSettingsRow(),
    profileUsage(),
    prisma.user.findMany({
      where: { role: EMPLOYEE_ROLE },
      select: EMPLOYEE_SELECT,
      orderBy: [{ active: 'desc' }, { name: 'asc' }],
    }),
  ])
  const assignments = await assignmentsAt(users.map((u) => u.id))

  return {
    profiles: profiles.map((p) => profileView(p, usage.get(p.id))),
    scale: globalScale.map((l) => ({ position: l.position, threshold: l.threshold, percent: l.percent })),
    workLevels: workLevels.map((l) => ({ position: l.position, title: l.title, minPoints: l.minPoints, hint: l.hint })),
    general: {
      overduePenaltyCap: settings.overduePenaltyCap,
      personalTaskDailyCap: settings.personalTaskDailyCap,
      notifyBank: settings.notifyBank,
      notifyPoints: settings.notifyPoints,
    },
    employees: users.map((u) => {
      const a = assignments.get(u.id)
      return { ...employeeCard(u), profileId: a?.profileId ?? null, assignedAt: a?.from ?? null }
    }),
  }
}

async function loadProfile(id, db = prisma) {
  const profile = await db.motivationProfile.findUnique({ where: { id }, include: PROFILE_INCLUDE })
  if (!profile) throw ApiError.notFound('Профиль не найден')
  return profile
}

async function assertTitleFree(title, exceptId) {
  const clash = await prisma.motivationProfile.findFirst({
    where: { title: { equals: title, mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  })
  if (clash) throw ApiError.conflict(`Профиль «${title}» уже есть`)
}

/** Условия профиля поменялись — сотрудник увидит новую дату в «Моих условиях». */
function touchConditions(profileId, db = prisma) {
  return db.motivationProfile.update({ where: { id: profileId }, data: { conditionsUpdatedAt: new Date() } })
}

/**
 * Новый профиль: пустой или копия существующего. Копировать удобно для
 * похожих должностей — «Бэкенд-разработчик» из «Разработчика» отличается
 * парой событий, набивать всё заново незачем.
 *
 * В пустой профиль сразу кладём «Клиент купил дополнительный продукт»: это
 * событие по заданию есть во всех профилях, и на него завязана отдельная
 * кнопка у руководителя.
 */
export async function createProfile(actor, { title, copyFromId }) {
  assertAdmin(actor)
  const name = title.trim()
  await assertTitleFree(name)

  return prisma.$transaction(async (tx) => {
    const source = copyFromId ? await loadProfile(copyFromId, tx) : null

    const profile = await tx.motivationProfile.create({
      data: {
        title: name,
        startBankCents: source?.startBankCents ?? 0,
        customScale: source?.customScale ?? false,
        workHints: source?.workHints ?? {},
      },
    })

    if (source) {
      if (source.eventTypes.length) {
        await tx.motivationEventType.createMany({
          data: source.eventTypes.map((t) => ({
            profileId: profile.id,
            title: t.title,
            example: t.example,
            prizePoints: t.prizePoints,
            levelPoints: t.levelPoints,
            mode: t.mode,
            autoRule: t.autoRule,
            systemKey: t.systemKey,
            enabled: t.enabled,
            position: t.position,
          })),
        })
      }
      if (source.prizeLevels.length) {
        await tx.motivationPrizeLevel.createMany({
          data: source.prizeLevels.map((l) => ({
            profileId: profile.id, position: l.position, threshold: l.threshold, percent: l.percent,
          })),
        })
      }
    } else {
      await tx.motivationEventType.create({
        data: {
          profileId: profile.id,
          title: 'Клиент купил дополнительный продукт',
          example: 'Клиент, с которым вы работали, заказал у агентства ещё одну услугу',
          prizePoints: 10,
          levelPoints: 10,
          mode: 'manual',
          systemKey: PRODUCT_KEY,
          position: 1,
        },
      })
    }

    return profileView(await loadProfile(profile.id, tx))
  })
}

/**
 * Правка профиля. Переименование условий не меняет, поэтому дату «Условия
 * обновлены» трогает только правка стартовой суммы, шкалы или подсказок.
 */
export async function updateProfile(actor, id, { title, startBank, customScale, workHints }) {
  assertAdmin(actor)
  const profile = await loadProfile(id)

  const data = {}
  if (title !== undefined && title.trim() !== profile.title) {
    await assertTitleFree(title.trim(), id)
    data.title = title.trim()
  }

  let conditionsChanged = false
  if (startBank !== undefined) {
    const cents = toCents(startBank)
    if (cents < 0) throw ApiError.badRequest('Стартовая сумма не может быть отрицательной')
    if (cents !== profile.startBankCents) { data.startBankCents = cents; conditionsChanged = true }
  }
  if (customScale !== undefined && customScale !== profile.customScale) {
    // Своя шкала без уровней ничего бы не изменила, а выглядела бы как
    // включённая. Сначала уровни, потом флаг.
    if (customScale && profile.prizeLevels.length === 0) {
      throw ApiError.badRequest('Сначала задайте уровни своей шкалы, потом включайте её')
    }
    data.customScale = customScale
    conditionsChanged = true
  }
  if (workHints !== undefined) {
    const clean = {}
    for (const [key, value] of Object.entries(workHints)) {
      if (typeof value === 'string' && value.trim()) clean[key] = value.trim()
    }
    data.workHints = clean
    conditionsChanged = true
  }
  if (conditionsChanged) data.conditionsUpdatedAt = new Date()

  if (Object.keys(data).length) await prisma.motivationProfile.update({ where: { id }, data })
  return profileView(await loadProfile(id))
}

/**
 * Удалить можно только профиль, который никому не назначался и по которому
 * не начислено ни одного события. Иначе по нему посчитано чьё-то прошлое,
 * и удаление стёрло бы, по каким условиям человек работал.
 */
export async function deleteProfile(actor, id) {
  assertAdmin(actor)
  await loadProfile(id)
  const [assigned, events] = await Promise.all([
    prisma.motivationAssignment.count({ where: { profileId: id } }),
    prisma.motivationEvent.count({ where: { profileId: id } }),
  ])
  if (assigned || events) {
    throw ApiError.conflict('Профиль уже назначался сотрудникам, по нему посчитана их история. Удалить его нельзя — можно переименовать или переназначить людей')
  }
  await prisma.motivationProfile.delete({ where: { id } })
}

function assertEventShape({ mode, autoRule }) {
  if (mode === 'auto' && !autoRule) throw ApiError.badRequest('Для автоматического события выберите правило')
  if (mode === 'manual' && autoRule) throw ApiError.badRequest('У ручного события не бывает автоматического правила')
}

function conflictOnRule(e) {
  if (e?.code === 'P2002') {
    throw ApiError.conflict('Такое автоматическое правило в профиле уже есть. Одна задача не должна давать баллы дважды')
  }
  throw e
}

/** Новое событие в профиле. Встаёт в конец списка. */
export async function createEventType(actor, profileId, body) {
  assertAdmin(actor)
  const profile = await loadProfile(profileId)
  const mode = body.mode ?? 'manual'
  const autoRule = mode === 'auto' ? body.autoRule : null
  assertEventShape({ mode, autoRule })

  const position = profile.eventTypes.reduce((m, t) => Math.max(m, t.position), 0) + 1
  try {
    await prisma.$transaction([
      prisma.motivationEventType.create({
        data: {
          profileId,
          title: body.title.trim(),
          example: body.example?.trim() || null,
          prizePoints: body.prizePoints,
          levelPoints: body.levelPoints ?? body.prizePoints,
          mode,
          autoRule,
          enabled: body.enabled ?? true,
          position,
        },
      }),
      touchConditions(profileId),
    ])
  } catch (e) {
    conflictOnRule(e)
  }
  return profileView(await loadProfile(profileId))
}

/** Правка события профиля. Начисленные раньше баллы не меняются. */
export async function updateEventType(actor, id, body) {
  assertAdmin(actor)
  const type = await prisma.motivationEventType.findUnique({ where: { id } })
  if (!type) throw ApiError.notFound('Событие не найдено')

  const mode = body.mode ?? type.mode
  const autoRule = mode === 'auto' ? (body.autoRule !== undefined ? body.autoRule : type.autoRule) : null
  assertEventShape({ mode, autoRule })

  // «Клиент купил продукт» — ручное событие с отдельной кнопкой. Сделать его
  // автоматическим значит сломать кнопку: автоматике не за что зацепиться.
  if (type.systemKey === PRODUCT_KEY && mode !== 'manual') {
    throw ApiError.badRequest('Покупку продукта отмечает руководитель, автоматической она быть не может')
  }

  const data = { mode, autoRule }
  if (body.title !== undefined) data.title = body.title.trim()
  if (body.example !== undefined) data.example = body.example?.trim() || null
  if (body.prizePoints !== undefined) data.prizePoints = body.prizePoints
  if (body.levelPoints !== undefined) data.levelPoints = body.levelPoints
  if (body.enabled !== undefined) data.enabled = body.enabled
  if (body.position !== undefined) data.position = body.position

  try {
    await prisma.$transaction([
      prisma.motivationEventType.update({ where: { id }, data }),
      touchConditions(type.profileId),
    ])
  } catch (e) {
    conflictOnRule(e)
  }
  return profileView(await loadProfile(type.profileId))
}

/**
 * Удаление события из профиля. Уже начисленное по нему остаётся: название и
 * баллы скопированы в каждую запись журнала. Событие покупки продукта
 * удалить нельзя — на него завязана кнопка руководителя; его можно только
 * выключить.
 */
export async function deleteEventType(actor, id) {
  assertAdmin(actor)
  const type = await prisma.motivationEventType.findUnique({ where: { id } })
  if (!type) throw ApiError.notFound('Событие не найдено')
  if (type.systemKey === PRODUCT_KEY) {
    throw ApiError.badRequest('Это событие нужно для кнопки «Клиент купил новый продукт». Его можно выключить, но не удалить')
  }
  await prisma.$transaction([
    prisma.motivationEventType.delete({ where: { id } }),
    touchConditions(type.profileId),
  ])
  return profileView(await loadProfile(type.profileId))
}

function normalizeLevels(levels) {
  return levels.map((l, i) => ({ position: i + 1, threshold: Number(l.threshold), percent: Number(l.percent) }))
}

/**
 * Шкала премии сохраняется целиком: старые уровни удаляются, новые пишутся
 * в той же транзакции. По одному уровню её не поправить — пороги и доли
 * обязаны расти, и проверять это имеет смысл только для шкалы целиком.
 *
 * profileId пустой — общая шкала. Её правка меняет условия всех профилей
 * без своей шкалы, поэтому их дата «Условия обновлены» тоже сдвигается.
 */
export async function saveScale(actor, profileId, levels) {
  assertAdmin(actor)
  const rows = normalizeLevels(levels)
  const errors = validateScale(rows)
  if (errors.length) throw ApiError.badRequest(errors[0], { errors })

  if (profileId) await loadProfile(profileId)

  await prisma.$transaction(async (tx) => {
    await tx.motivationPrizeLevel.deleteMany({ where: { profileId: profileId ?? null } })
    await tx.motivationPrizeLevel.createMany({ data: rows.map((r) => ({ ...r, profileId: profileId ?? null })) })
    const now = new Date()
    if (profileId) {
      await tx.motivationProfile.update({ where: { id: profileId }, data: { conditionsUpdatedAt: now } })
    } else {
      await tx.motivationProfile.updateMany({ where: { customScale: false }, data: { conditionsUpdatedAt: now } })
    }
  })

  return profileId ? profileView(await loadProfile(profileId)) : rows
}

/**
 * Уровни работы — тоже целиком. Касаются всех профилей.
 *
 * Подсказки профилей привязаны к номеру уровня. Если админ вставил уровень
 * в середину или убрал один, номера сдвигаются — поэтому подсказки
 * переносятся вслед за своим уровнем: фронт присылает, каким по счёту
 * уровень был до правки (from). Подсказки убранного уровня уходят вместе с
 * ним, у нового уровня их пока нет.
 */
export async function saveWorkLevels(actor, levels) {
  assertAdmin(actor)
  const rows = levels.map((l, i) => ({
    position: i + 1,
    title: String(l.title ?? '').trim(),
    minPoints: Number(l.minPoints),
    hint: String(l.hint ?? '').trim(),
  }))
  const errors = validateWorkLevels(rows)
  if (errors.length) throw ApiError.badRequest(errors[0], { errors })

  // «Был третьим — стал четвёртым»: старый номер → новый. Переносим всегда,
  // когда фронт прислал старые номера: так и сдвиг, и удаление, и новый
  // уровень обрабатываются одинаково, и подсказка убранного уровня не
  // всплывёт потом у нового уровня на том же месте.
  const moves = new Map()
  levels.forEach((l, i) => { if (l.from) moves.set(String(l.from), String(i + 1)) })
  const remap = levels.some((l) => l.from !== undefined)

  await prisma.$transaction(async (tx) => {
    await tx.motivationWorkLevel.deleteMany({})
    await tx.motivationWorkLevel.createMany({ data: rows })
    const now = new Date()
    if (!remap) {
      await tx.motivationProfile.updateMany({ data: { conditionsUpdatedAt: now } })
      return
    }
    const profiles = await tx.motivationProfile.findMany({ select: { id: true, workHints: true } })
    for (const p of profiles) {
      const hints = (p.workHints && typeof p.workHints === 'object') ? p.workHints : {}
      const moved = {}
      for (const [oldPos, text] of Object.entries(hints)) {
        const newPos = moves.get(oldPos)
        if (newPos) moved[newPos] = text
      }
      await tx.motivationProfile.update({ where: { id: p.id }, data: { workHints: moved, conditionsUpdatedAt: now } })
    }
  })
  return rows
}

/** Лимит штрафа, потолок за личные задачи и переключатели уведомлений. */
export async function updateGeneral(actor, patch) {
  assertAdmin(actor)
  const data = {}
  for (const key of ['overduePenaltyCap', 'personalTaskDailyCap', 'notifyBank', 'notifyPoints']) {
    if (patch[key] !== undefined) data[key] = patch[key]
  }
  const row = await prisma.motivationSettings.upsert({
    where: { id: 'global' },
    create: { id: 'global', ...data },
    update: data,
  })
  return {
    overduePenaltyCap: row.overduePenaltyCap,
    personalTaskDailyCap: row.personalTaskDailyCap,
    notifyBank: row.notifyBank,
    notifyPoints: row.notifyPoints,
  }
}

/**
 * Назначить сотруднику профиль. Новая запись с текущего момента, старые не
 * трогаются: события до перевода посчитаны по прежним условиям и так и
 * останутся. Тот же профиль ещё раз ничего не создаёт.
 */
export async function assignProfile(actor, userId, profileId) {
  assertAdmin(actor)
  const user = await prisma.user.findUnique({ where: { id: userId }, select: EMPLOYEE_SELECT })
  if (!user || user.role !== EMPLOYEE_ROLE) {
    throw ApiError.badRequest('Профиль назначается только сотрудникам: у руководителей и админа нет банка и баллов')
  }
  await loadProfile(profileId)

  const current = (await assignmentsAt([userId])).get(userId)
  if (current?.profileId === profileId) {
    return { ...employeeCard(user), profileId, assignedAt: current.from }
  }

  const created = await prisma.motivationAssignment.create({
    data: { userId, profileId, from: new Date(), createdById: actor.id },
  })
  return { ...employeeCard(user), profileId, assignedAt: created.from }
}
