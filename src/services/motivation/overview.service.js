import { prisma } from '../../config/prisma.js'
import { ApiError } from '../../utils/ApiError.js'
import { computeMonth } from './engine.js'
import { currentMonthKey, dayKeyOf, isMonthKey, monthKeyOf, referenceMoment } from './month.js'
import { autoActiveAt } from './taskRules.js'
import { assertCanView, assertParticipant, canManage, loadEmployee } from './access.js'
import { assignmentAt, getGlobalScale, getSettingsRow, getWorkLevels, scaleOf, usesCustomScale, workLevelsOf } from './profiles.js'
import { availableMonths, ensureStartBank, loadJournals } from './journal.js'
import { bankEntry, employeeCard, eventEntry, eventTypeCard, newestFirst, profileCard } from './shape.js'

/**
 * Экраны «Моя мотивация» и «Мои условия».
 *
 * Сотрудник открывает их про себя, руководитель и админ — про любого, кем
 * управляют: в задании клик по человеку в таблице команды открывает «его
 * экраны в режиме просмотра, включая „Мои условия“». Поэтому оба экрана
 * собираются одной функцией, а разница только в том, кто смотрит.
 */

function resolveMonth(month, now = new Date()) {
  if (month === undefined || month === null || month === '') return currentMonthKey(now)
  if (!isMonthKey(month)) throw ApiError.badRequest('Месяц нужен в виде ГГГГ-ММ')
  if (month > currentMonthKey(now)) throw ApiError.badRequest('Будущий месяц ещё не начался')
  return month
}

/**
 * Всё, что нужно для расчёта месяца сотрудника. Отдельно от формы ответа:
 * этим же пользуются условия (суммы уровней при текущем банке) и действия
 * руководителя (проверка, что списание не больше банка).
 */
export async function loadMonthState(employee, monthKey, now = new Date()) {
  const refAt = referenceMoment(monthKey, now)

  // Стартовая сумма появляется до чтения журнала, чтобы сразу в него попасть.
  await ensureStartBank(employee, monthKey, now)
  const assignment = await assignmentAt(employee.id, refAt)

  const [journals, globalScale, workLevels] = await Promise.all([
    loadJournals(employee.id, monthKey),
    getGlobalScale(),
    getWorkLevels(),
  ])

  const profile = assignment?.profile ?? null
  const levels = scaleOf(profile, globalScale)
  const work = workLevelsOf(profile, workLevels)
  const result = computeMonth({ levels, workLevels: work, bankEntries: journals.bankEntries, events: journals.events })

  return { assignment, profile, journals, result, globalScale, workLevels: work }
}

async function seenFor(userId) {
  return prisma.motivationSeen.findUnique({ where: { userId } })
}

/**
 * Экран «Моя мотивация» за месяц.
 *
 * Отметки «новое» ставятся, только когда человек смотрит на себя сам:
 * руководитель, открывший его карточку, не должен гасить сотруднику
 * подсветку пополнения, которое тот ещё не видел.
 */
export async function getOverview(actor, userId, month, now = new Date()) {
  const employee = await loadEmployee(userId)
  assertCanView(actor, employee)

  const monthKey = resolveMonth(month, now)
  const isSelf = actor.id === employee.id
  const [state, months, seen] = await Promise.all([
    loadMonthState(employee, monthKey, now),
    availableMonths(employee.id, now),
    isSelf ? seenFor(employee.id) : Promise.resolve(undefined),
  ])

  const bankSeenAt = isSelf ? (seen?.bankSeenAt ?? null) : undefined
  const eventsSeenAt = isSelf ? (seen?.eventsSeenAt ?? null) : undefined

  const bankHistory = newestFirst(state.journals.bankEntries.map((e) => bankEntry(e, bankSeenAt)))
  const history = newestFirst(state.journals.events.map((e) => eventEntry(e, eventsSeenAt)))

  // «+50 $ в банке» — насколько банк изменился с прошлого визита: новые
  // пополнения минус новые списания. Одни пополнения врали бы, если между
  // визитами админ что-то списал: «+250 $» при банке в 180 $ сбивает с толку.
  const unseenBankCents = Math.max(0, bankHistory.filter((e) => e.isNew).reduce((s, e) => s + e.amountCents, 0))
  const unseenEvents = history.filter((e) => e.isNew).length

  const { result } = state
  const isCurrent = monthKey === currentMonthKey(now)
  // Закрытый месяц — премия и банк из снимка закрытия: шкалу потом могли
  // поменять, а итог месяца уже зафиксирован. История — из журналов.
  const [closed, snap] = isCurrent
    ? [null, null]
    : await Promise.all([
      prisma.motivationMonthClose.findUnique({ where: { monthKey }, select: { closedAt: true } }),
      prisma.motivationMonthResult.findUnique({ where: { monthKey_userId: { monthKey, userId: employee.id } } }),
    ])
  const canManageEmployee = canManage(actor, employee)
  return {
    employee: employeeCard(employee),
    month: monthKey,
    currentMonth: currentMonthKey(now),
    isCurrent,
    months: months.includes(monthKey) ? months : [monthKey, ...months],
    profile: profileCard(state.profile),
    scale: usesCustomScale(state.profile) ? 'custom' : 'global',
    closedAt: closed?.closedAt ?? null,
    bank: {
      cents: snap ? snap.bankCents : result.bankCents,
      isEmpty: (snap ? snap.bankCents : result.bankCents) === 0,
      history: bankHistory,
    },
    prize: snap
      ? { points: snap.prizePoints, levels: snap.levels, currentLevel: snap.currentLevel, earnedCents: snap.earnedCents, next: null }
      : {
        points: result.prizePoints,
        levels: result.levels,
        currentLevel: result.currentLevel,
        earnedCents: result.earnedCents,
        next: result.next,
      },
    work: snap?.work?.levels
      ? { points: snap.levelPoints, levels: snap.work.levels, current: snap.work.current, next: snap.work.next, pointsLeft: snap.work.pointsLeft }
      : {
        points: result.levelPoints,
        levels: result.work.levels,
        current: result.work.current,
        next: result.work.next,
        pointsLeft: result.work.pointsLeft,
      },
    history,
    unseen: isSelf ? { bankCents: unseenBankCents, events: unseenEvents } : null,
    permissions: {
      // Всё это — только владелец. Руководитель и сам сотрудник смотрят.
      canManage: canManageEmployee,
      canWriteOff: canManageEmployee,
      // Закрытый месяц уже посчитан — отменять в нём нечего.
      canCancel: canManageEmployee && !closed,
    },
  }
}

/** Свой экран сотрудника или руководителя. У владельца банка нет. */
export async function getMyOverview(actor, month, now = new Date()) {
  assertParticipant(actor)
  return getOverview(actor, actor.id, month, now)
}

/**
 * «Мои условия»: правила игры для должности сотрудника. Только чтение —
 * панель берёт всё из профиля и после его правки обновляется сама.
 */
export async function getConditions(actor, userId, now = new Date()) {
  const employee = await loadEmployee(userId)
  assertCanView(actor, employee)

  const monthKey = currentMonthKey(now)
  const [state, settings] = await Promise.all([loadMonthState(employee, monthKey, now), getSettingsRow()])
  const { profile, result } = state

  const types = (profile?.eventTypes ?? []).filter((t) => t.enabled).map(eventTypeCard)

  return {
    employee: employeeCard(employee),
    profile: profileCard(profile),
    scale: usesCustomScale(profile) ? 'custom' : 'global',
    earn: types.filter((t) => !t.isPenalty),
    penalties: types.filter((t) => t.isPenalty),
    // Суммы уровней — те же, что на шкале прямо сейчас, с учётом уже
    // пройденных уровней. Иначе в условиях и на шкале стояли бы разные
    // цифры, и человек не понял бы, какой верить.
    prizeLevels: result.levels,
    bankCents: result.bankCents,
    workLevels: result.work.levels,
    rules: {
      overduePenaltyCap: settings.overduePenaltyCap,
      personalTaskDailyCap: settings.personalTaskDailyCap,
      startBankCents: profile?.startBankCents ?? 0,
      // Автобаллы за задачи: с какого дня и работают ли уже. Без этого
      // человек видел бы «+2 за задачу в срок» и не понимал, почему их нет.
      autoTasksFrom: settings.autoTasksFrom ? dayKeyOf(settings.autoTasksFrom) : null,
      autoTasksOn: autoActiveAt(settings.autoTasksFrom, now),
      // Пока баллы за задачи проверяет владелец, в условиях так и пишем.
      taskPointsMode: settings.taskPointsMode,
    },
    month: monthKeyOf(now),
  }
}

export async function getMyConditions(actor, now = new Date()) {
  assertParticipant(actor)
  return getConditions(actor, actor.id, now)
}

/**
 * Сотрудник увидел новое — гасим подсветку пополнений и баллов.
 *
 * Фронт присылает время самой свежей записи из того ответа, что был на
 * экране. «Сейчас» сервера не годится: пополнение, пришедшее, пока страница
 * открыта, человек ещё не видел, и гасить его подсветку рано. Без времени
 * (старый клиент) — как раньше, по текущему моменту. В будущее метку не
 * ставим, и назад она не откатывается.
 */
export async function markSeen(actor, { bankUntil, eventsUntil } = {}, now = new Date()) {
  assertParticipant(actor)
  const clamp = (d) => (d && new Date(d).getTime() < now.getTime() ? new Date(d) : now)
  const current = await prisma.motivationSeen.findUnique({ where: { userId: actor.id } })
  const later = (a, b) => (!b || a.getTime() > new Date(b).getTime() ? a : new Date(b))

  const bankSeenAt = later(clamp(bankUntil), current?.bankSeenAt)
  const eventsSeenAt = later(clamp(eventsUntil), current?.eventsSeenAt)
  await prisma.motivationSeen.upsert({
    where: { userId: actor.id },
    create: { userId: actor.id, bankSeenAt, eventsSeenAt },
    update: { bankSeenAt, eventsSeenAt },
  })
  return { ok: true }
}
