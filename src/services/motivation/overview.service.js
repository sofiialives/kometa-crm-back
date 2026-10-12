import { prisma } from '../../config/prisma.js'
import { ApiError } from '../../utils/ApiError.js'
import { computeMonth } from './engine.js'
import { currentMonthKey, isMonthKey, monthKeyOf, referenceMoment } from './month.js'
import { assertCanView, assertEmployee, canManage, loadEmployee } from './access.js'
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
export async function loadMonthState(userId, monthKey, now = new Date()) {
  const refAt = referenceMoment(monthKey, now)
  const assignment = await assignmentAt(userId, refAt)

  // Стартовая сумма появляется до чтения журнала, чтобы сразу в него попасть.
  await ensureStartBank(userId, monthKey, assignment, now)

  const [journals, globalScale, workLevels] = await Promise.all([
    loadJournals(userId, monthKey),
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
    loadMonthState(employee.id, monthKey, now),
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
  return {
    employee: employeeCard(employee),
    month: monthKey,
    isCurrent: monthKey === currentMonthKey(now),
    months: months.includes(monthKey) ? months : [monthKey, ...months],
    profile: profileCard(state.profile),
    scale: usesCustomScale(state.profile) ? 'custom' : 'global',
    bank: {
      cents: result.bankCents,
      isEmpty: result.bankCents === 0,
      history: bankHistory,
    },
    prize: {
      points: result.prizePoints,
      levels: result.levels,
      currentLevel: result.currentLevel,
      earnedCents: result.earnedCents,
      next: result.next,
    },
    work: {
      points: result.levelPoints,
      levels: result.work.levels,
      current: result.work.current,
      next: result.work.next,
      pointsLeft: result.work.pointsLeft,
    },
    history,
    unseen: isSelf ? { bankCents: unseenBankCents, events: unseenEvents } : null,
    permissions: {
      canManage: canManage(actor, employee),
      canWriteOff: actor.role === 'admin',
    },
  }
}

/** Свой экран сотрудника. У руководителя и админа банка нет. */
export async function getMyOverview(actor, month, now = new Date()) {
  assertEmployee(actor)
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
  const [state, settings] = await Promise.all([loadMonthState(employee.id, monthKey, now), getSettingsRow()])
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
    },
    month: monthKeyOf(now),
  }
}

export async function getMyConditions(actor, now = new Date()) {
  assertEmployee(actor)
  return getConditions(actor, actor.id, now)
}

/** Сотрудник увидел новое — гасим подсветку пополнений и баллов. */
export async function markSeen(actor, now = new Date()) {
  assertEmployee(actor)
  await prisma.motivationSeen.upsert({
    where: { userId: actor.id },
    create: { userId: actor.id, bankSeenAt: now, eventsSeenAt: now },
    update: { bankSeenAt: now, eventsSeenAt: now },
  })
  return { ok: true }
}
