import { prisma } from '../../config/prisma.js'
import { ApiError } from '../../utils/ApiError.js'
import { assertCanView, assertViewer, canView, EMPLOYEE_SELECT, loadEmployee, PARTICIPANT_ROLES } from './access.js'
import { breakItem, forceMajeureItem, groupByDay, redact, summarize, sumSummaries } from './botJournalRules.js'
import { currentMonthKey, monthRange, monthsBetween, shiftMonth } from './month.js'
import { employeeCard } from './shape.js'

/**
 * «Журнал бота» — что было с человеком в телеграме за месяц: отлучки и
 * сколько его не было, опоздания и продления, форс-мажоры, чек-ины,
 * «задерживаюсь», «не успеваю», «беру в работу», конец дня. Сверху сводка.
 *
 * Владелец видит всё, включая переписку и слова человека. Руководитель —
 * только свой отдел и только факты: без переписки, причин отлучек,
 * форс-мажоров и ответов на чек-ин — там бывает личное («заболел»).
 */

const MESSAGES_LIMIT = 2000

/** Кого можно выбрать в журнале: владелец — всех с банком, руководитель — свой отдел. */
export async function journalPeople(actor) {
  assertViewer(actor)
  const users = await prisma.user.findMany({
    where: { role: { in: PARTICIPANT_ROLES }, active: true },
    select: EMPLOYEE_SELECT,
    orderBy: [{ name: 'asc' }, { email: 'asc' }],
  })
  return users.filter((u) => canView(actor, u)).map(employeeCard)
}

const OVERDUE = ['task_overdue', 'personal_task_overdue']

async function penaltiesOf(answers) {
  const penalties = await prisma.motivationEvent.findMany({
    where: { id: { in: answers.map((a) => a.eventId).filter(Boolean) } },
    select: { id: true, prizePoints: true, cancelledAt: true },
  })
  return new Map(penalties.map((p) => [p.id, p]))
}

/** Строки журнала из выбранных записей (одного человека или нескольких). */
function buildItems({ aways, answers, events, overdueReviews, overdueAuto }, penaltyOf, now, window) {
  const items = []
  for (const a of aways) {
    if (a.kind === 'break') items.push({ ...breakItem(a, now, window), reason: a.reason, userId: a.userId })
    else items.push({ ...forceMajeureItem(a, window), userId: a.userId })
  }
  for (const a of answers) {
    // Чек-ин, который не начинался (день пропущен), — не событие.
    if (!a.checkin.startedAt) continue
    const penalty = a.eventId ? penaltyOf.get(a.eventId) : null
    items.push({
      kind: 'checkin',
      userId: a.userId,
      id: a.id,
      at: a.checkin.startedAt,
      status: a.status,
      answeredAt: a.answeredAt,
      answer: a.answer,
      points: penalty ? penalty.prizePoints : null,
      penaltyCancelled: Boolean(penalty?.cancelledAt),
    })
  }
  for (const e of events) items.push({ kind: e.type, userId: e.userId, id: e.id, at: e.at, text: e.text, data: e.data ?? null })
  for (const r of overdueReviews) {
    items.push({ kind: 'task_overdue', userId: r.userId, id: r.id, at: r.occurredAt, text: null, data: { taskTitle: r.taskTitle, nights: r.nights.length, points: r.status === 'rejected' ? null : r.prizePoints } })
  }
  for (const e of overdueAuto) {
    items.push({ kind: 'task_overdue', userId: e.userId, id: e.id, at: e.occurredAt, text: null, data: { taskTitle: e.taskTitle, nights: 1, points: e.cancelledAt ? null : e.prizePoints } })
  }
  return items
}

/** Запросы журнала за месяц для одного человека (userId) или нескольких ({ in }). */
function monthQueries(userFilter, window) {
  const { start, end } = window
  return [
    // Пересекает месяц и не снята до его начала.
    prisma.motivationAway.findMany({
      where: { userId: userFilter, from: { lt: end }, until: { gt: start }, OR: [{ endedAt: null }, { endedAt: { gt: start } }] },
      include: { createdBy: { select: { name: true } } },
      orderBy: { from: 'asc' },
    }),
    prisma.botCheckinAnswer.findMany({
      where: { userId: userFilter, checkin: { day: { startsWith: window.monthKey } } },
      include: { checkin: { select: { day: true, startedAt: true } } },
    }),
    prisma.botEvent.findMany({ where: { userId: userFilter, at: { gte: start, lt: end } }, orderBy: { at: 'asc' } }),
    // Просрочки — из заявок «На проверке» и из автоматических штрафов: сами
    // закрытые задачи CRM ночью убирает, а след о просрочке остаётся.
    prisma.motivationReview.findMany({
      where: { userId: userFilter, rule: { in: OVERDUE }, occurredAt: { gte: start, lt: end } },
      select: { id: true, userId: true, taskTitle: true, occurredAt: true, nights: true, prizePoints: true, status: true },
    }),
    prisma.motivationEvent.findMany({
      where: { userId: userFilter, occurredAt: { gte: start, lt: end }, OR: OVERDUE.map((r) => ({ dedupeKey: { startsWith: `auto:${r}:` } })) },
      select: { id: true, userId: true, taskTitle: true, occurredAt: true, prizePoints: true, cancelledAt: true },
    }),
  ]
}

/**
 * Журнал всей команды или отдела: у каждого человека те же счётчики, что в
 * одиночном отчёте, и итог по всем. Переписку и тексты не отдаём — только
 * числа. Владелец видит всех, руководитель только свой отдел (scope=all у
 * него значит «мой отдел»).
 */
export async function getBotJournalTeam(actor, { scope, departmentId, month }, now = new Date()) {
  assertViewer(actor)
  let department = null
  if (departmentId) {
    department = await prisma.department.findUnique({ where: { id: departmentId }, select: { id: true, name: true } })
    // Руководителю чужой отдел — как несуществующий.
    if (!department || (actor.role !== 'admin' && departmentId !== actor.departmentId)) {
      throw ApiError.notFound('Отдел не найден')
    }
  }
  const monthKey = month || currentMonthKey(now)
  const window = { ...monthRange(monthKey), monthKey }

  const users = (await prisma.user.findMany({
    where: { role: { in: PARTICIPANT_ROLES }, active: true, ...(departmentId ? { departmentId } : {}) },
    select: EMPLOYEE_SELECT,
    orderBy: [{ name: 'asc' }, { email: 'asc' }],
  })).filter((u) => canView(actor, u))
  const ids = users.map((u) => u.id)

  const [aways, answers, events, overdueReviews, overdueAuto, links] = ids.length
    ? await Promise.all([...monthQueries({ in: ids }, window), prisma.telegramLink.findMany({ where: { userId: { in: ids } }, select: { userId: true, chatId: true } })])
    : [[], [], [], [], [], []]
  const items = buildItems({ aways, answers, events, overdueReviews, overdueAuto }, await penaltiesOf(answers), now, window)
  const byUser = new Map(ids.map((id) => [id, []]))
  for (const i of items) byUser.get(i.userId)?.push(i)
  const linked = new Set(links.filter((l) => l.chatId).map((l) => l.userId))

  const people = users.map((u) => ({
    employee: employeeCard(u),
    telegram: linked.has(u.id),
    summary: summarize(byUser.get(u.id)),
  }))
  return {
    scope: department ? 'department' : 'all',
    department,
    month: monthKey,
    months: monthsBetween(shiftMonth(currentMonthKey(now), -11), currentMonthKey(now)).reverse(),
    currentMonth: currentMonthKey(now),
    full: actor.role === 'admin',
    people,
    totals: sumSummaries(people.map((p) => p.summary)),
  }
}

export async function getBotJournal(actor, { userId, month }, now = new Date()) {
  assertViewer(actor)
  const employee = await loadEmployee(userId)
  assertCanView(actor, employee)
  const full = actor.role === 'admin'
  const monthKey = month || currentMonthKey(now)
  const window = monthRange(monthKey)
  const { start, end } = window

  const wnd = { ...window, monthKey }
  const [aways, answers, events, overdueReviews, overdueAuto, latest, linked] = await Promise.all([
    ...monthQueries(userId, wnd),
    // Переписку — только владельцу и с конца: у очень активных обрежутся
    // самые старые дни, а не свежие.
    full
      ? prisma.botMessage.findMany({
        where: { userId, createdAt: { gte: start, lt: end } },
        orderBy: { createdAt: 'desc' },
        take: MESSAGES_LIMIT + 1,
        select: { createdAt: true, direction: true, text: true },
      })
      : [],
    prisma.telegramLink.findUnique({ where: { userId }, select: { chatId: true } }),
  ])
  const messages = latest.slice(0, MESSAGES_LIMIT).reverse()

  const penaltyOf = await penaltiesOf(answers)
  const items = buildItems({ aways, answers, events, overdueReviews, overdueAuto }, penaltyOf, now, window)

  return {
    employee: employeeCard(employee),
    month: monthKey,
    months: monthsBetween(shiftMonth(currentMonthKey(now), -11), currentMonthKey(now)).reverse(),
    currentMonth: currentMonthKey(now),
    telegram: Boolean(linked?.chatId),
    full,
    messagesTruncated: latest.length > MESSAGES_LIMIT,
    summary: summarize(items),
    days: groupByDay(items.map((i) => redact(i, full)), messages.map((m) => ({ at: m.createdAt, direction: m.direction, text: m.text }))),
  }
}
