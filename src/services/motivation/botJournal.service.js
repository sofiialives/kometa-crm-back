import { prisma } from '../../config/prisma.js'
import { assertCanView, assertViewer, canView, EMPLOYEE_SELECT, loadEmployee, PARTICIPANT_ROLES } from './access.js'
import { breakItem, groupByDay, summarize } from './botJournalRules.js'
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

export async function getBotJournal(actor, { userId, month }, now = new Date()) {
  assertViewer(actor)
  const employee = await loadEmployee(userId)
  assertCanView(actor, employee)
  const full = actor.role === 'admin'
  const monthKey = month || currentMonthKey(now)
  const { start, end } = monthRange(monthKey)

  const [aways, answers, events, messages, linked] = await Promise.all([
    prisma.motivationAway.findMany({
      where: { userId, from: { lt: end }, until: { gt: start } },
      include: { createdBy: { select: { name: true } } },
      orderBy: { from: 'asc' },
    }),
    prisma.botCheckinAnswer.findMany({
      where: { userId, checkin: { day: { startsWith: monthKey } } },
      include: { checkin: { select: { day: true, startedAt: true, plannedAt: true } } },
    }),
    prisma.botEvent.findMany({ where: { userId, at: { gte: start, lt: end } }, orderBy: { at: 'asc' } }),
    full
      ? prisma.botMessage.findMany({
        where: { userId, createdAt: { gte: start, lt: end } },
        orderBy: { createdAt: 'asc' },
        take: MESSAGES_LIMIT,
        select: { createdAt: true, direction: true, text: true },
      })
      : [],
    prisma.telegramLink.findUnique({ where: { userId }, select: { chatId: true } }),
  ])

  const penalties = await prisma.motivationEvent.findMany({
    where: { id: { in: answers.map((a) => a.eventId).filter(Boolean) } },
    select: { id: true, prizePoints: true, cancelledAt: true },
  })
  const penaltyOf = new Map(penalties.map((p) => [p.id, p]))

  const items = []
  for (const a of aways) {
    if (a.kind === 'break') {
      items.push({ ...breakItem(a, now), reason: full ? a.reason : null })
    } else {
      items.push({
        kind: 'force_majeure',
        id: a.id,
        at: a.from,
        until: a.until,
        endedAt: a.endedAt,
        source: a.source,
        by: a.createdBy?.name ?? null,
        reason: full ? a.reason : null,
      })
    }
  }
  for (const a of answers) {
    // Чек-ин, который ещё не начался или день пропущен, — не событие.
    if (!a.checkin.startedAt) continue
    const penalty = a.eventId ? penaltyOf.get(a.eventId) : null
    items.push({
      kind: 'checkin',
      id: a.id,
      at: a.checkin.startedAt,
      status: a.status,
      answeredAt: a.answeredAt,
      // Ответ — что человек делает; причина пропуска бывает личной.
      answer: full ? a.answer : null,
      points: penalty && !penalty.cancelledAt ? penalty.prizePoints : null,
    })
  }
  for (const e of events) {
    items.push({ kind: e.type, id: e.id, at: e.at, text: full ? e.text : null, data: publicData(e, full) })
  }

  return {
    employee: employeeCard(employee),
    month: monthKey,
    months: monthsBetween(shiftMonth(currentMonthKey(now), -11), currentMonthKey(now)).reverse(),
    currentMonth: currentMonthKey(now),
    telegram: Boolean(linked?.chatId),
    full,
    summary: summarize(items),
    days: groupByDay(items, messages.map((m) => ({ at: m.createdAt, direction: m.direction, text: m.text }))),
  }
}

/** Данные события без лишнего: руководителю — без того, что человек написал. */
function publicData(event, full) {
  const data = event.data ?? null
  if (!data || full) return data
  const { taskTitle, taskId, startAt, until, approved } = data
  return { taskTitle, taskId, startAt, until, approved }
}
