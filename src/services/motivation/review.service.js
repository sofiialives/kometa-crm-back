import { prisma } from '../../config/prisma.js'
import { ApiError } from '../../utils/ApiError.js'
import { assertAdmin, EMPLOYEE_SELECT } from './access.js'
import { currentMonthKey, dayKeyOf, monthKeyOf } from './month.js'
import { assignmentAt, getSettingsRow } from './profiles.js'
import { employeeCard, person } from './shape.js'
import { mskDayStart } from './taskRules.js'
import { pendingHints } from './workHints.service.js'

/**
 * Очередь «На проверке». CRM заметила, что задача закрыта в срок или
 * просрочена, и положила заявку с подсказанными баллами
 * (autoTasks.service.js). Начисляет владелец: «Начислить» создаёт обычное
 * событие в журнале баллов, «Не начислять» закрывает заявку без баллов.
 *
 * Пока заказчик проверяет систему, баллы за задачи идут только так. Потом
 * в настройках можно переключить на автоматическое начисление.
 */

const INCLUDE = {
  user: { select: EMPLOYEE_SELECT },
  decidedBy: { select: { id: true, name: true } },
  event: { select: { id: true, prizePoints: true, levelPoints: true, cancelledAt: true } },
}

const lockUser = (tx, userId) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}))`

function reviewCard(r, extra = {}, now = new Date()) {
  return {
    // Заявка прошлого месяца начислится в текущий: прошлый уже посчитан.
    previousMonth: monthKeyOf(r.occurredAt) !== currentMonthKey(now),
    id: r.id,
    rule: r.rule,
    title: r.title,
    prizePoints: r.prizePoints,
    levelPoints: r.levelPoints,
    task: r.taskId || r.taskTitle
      ? { id: r.taskId, title: r.taskTitle, description: r.taskDescription, deadline: r.taskDeadline }
      : null,
    complexity: r.complexity,
    nights: r.nights.length,
    occurredAt: r.occurredAt,
    status: r.status,
    decidedAt: r.decidedAt,
    decidedBy: person(r.decidedBy),
    decisionNote: r.decisionNote,
    awarded: r.event ? { prizePoints: r.event.prizePoints, levelPoints: r.event.levelPoints, cancelled: Boolean(r.event.cancelledAt) } : null,
    employee: employeeCard(r.user),
    createdAt: r.createdAt,
    ...extra,
  }
}

/**
 * Сколько баллов человек уже получил за личные задачи в эти сутки — по
 * заявкам и автоматически. Владелец видит это рядом с заявкой и сам решает,
 * упираться ли в дневной потолок.
 */
async function personalDayTotals(reviews) {
  const personal = reviews.filter((r) => r.rule === 'personal_task_on_time' && r.status === 'pending')
  const keys = new Map()
  for (const r of personal) {
    const day = mskDayStart(r.occurredAt)
    keys.set(`${r.userId}:${day.getTime()}`, { userId: r.userId, day })
  }
  const totals = new Map()
  for (const [key, { userId, day }] of keys) {
    const sum = await prisma.motivationEvent.aggregate({
      where: {
        userId,
        cancelledAt: null,
        occurredAt: { gte: day, lt: new Date(day.getTime() + 24 * 60 * 60 * 1000) },
        OR: [
          { dedupeKey: { startsWith: 'auto:personal_task_on_time:' } },
          { review: { rule: 'personal_task_on_time' } },
        ],
      },
      _sum: { prizePoints: true },
    })
    totals.set(key, sum._sum.prizePoints ?? 0)
  }
  return (r) => (r.rule === 'personal_task_on_time' ? totals.get(`${r.userId}:${mskDayStart(r.occurredAt).getTime()}`) ?? 0 : null)
}

/**
 * Очередь для владельца. pending — ждут решения, старые сверху: их пора
 * разобрать первыми. decided — последние решённые, для проверки себя.
 */
export async function listReviews(actor, { status = 'pending' } = {}) {
  assertAdmin(actor, 'Очередь «На проверке» видит только владелец')
  const decided = status === 'decided'
  const [rows, pending, settings] = await Promise.all([
    prisma.motivationReview.findMany({
      where: decided ? { status: { in: ['approved', 'rejected', 'withdrawn'] } } : { status: 'pending' },
      include: INCLUDE,
      orderBy: decided ? { decidedAt: 'desc' } : { occurredAt: 'asc' },
      take: decided ? 50 : 300,
    }),
    prisma.motivationReview.count({ where: { status: 'pending' } }),
    getSettingsRow(),
  ])
  const dayTotal = decided ? () => null : await personalDayTotals(rows)
  return {
    pending,
    // Включены ли баллы за задачи и как: пустая очередь должна объяснять,
    // почему она пустая.
    taskPoints: {
      from: settings.autoTasksFrom ? dayKeyOf(settings.autoTasksFrom) : null,
    },
    personalTaskDailyCap: settings.personalTaskDailyCap,
    items: rows.map((r) => reviewCard(r, { personalDayPoints: dayTotal(r) })),
  }
}

/** Сколько заявок и подсказок о новых работах ждёт — для счётчика на вкладке. */
export async function pendingCount(actor) {
  assertAdmin(actor)
  const [pending, hints] = await Promise.all([
    prisma.motivationReview.count({ where: { status: 'pending' } }),
    pendingHints(),
  ])
  return { pending, hints }
}

async function loadPending(tx, id) {
  const review = await tx.motivationReview.findUnique({ where: { id }, include: INCLUDE })
  if (!review) throw ApiError.notFound('Заявка не найдена')
  return review
}

function assertStillPending(r) {
  if (r.status === 'withdrawn') throw ApiError.conflict('Задачу вернули из «Готово» — заявка снята')
  if (r.status !== 'pending') throw ApiError.conflict('По этой заявке уже есть решение')
}

/**
 * «Начислить». Можно поменять подсказанные баллы. Событие датируется
 * моментом самой задачи, если он в текущем месяце: так баллы встают в
 * историю на своё место. Заявка из прошлого месяца начисляется сегодняшним
 * днём — прошлый месяц уже посчитан.
 *
 * Повторное нажатие (ответ потерялся) отдаёт уже сделанное, а не
 * начисляет второй раз.
 */
export async function approveReview(actor, id, { prizePoints, levelPoints, comment, seenPrizePoints } = {}, now = new Date()) {
  assertAdmin(actor, 'Начислять баллы может только владелец')
  const first = await prisma.motivationReview.findUnique({ where: { id }, select: { userId: true } })
  if (!first) throw ApiError.notFound('Заявка не найдена')

  const review = await prisma.$transaction(async (tx) => {
    await lockUser(tx, first.userId)
    const r = await loadPending(tx, id)
    if (r.status === 'approved') return r
    assertStillPending(r)
    if (!r.user.active) throw ApiError.badRequest('Сотрудник отключён — начислять ему нельзя')
    // Пока владелец смотрел, ночь добавила к просрочке ещё штраф — пусть
    // увидит новое число, а не начислит то, чего не видел.
    if (seenPrizePoints !== undefined && seenPrizePoints !== r.prizePoints) {
      throw ApiError.conflict(`Заявка обновилась: теперь подсказано ${r.prizePoints > 0 ? '+' : ''}${r.prizePoints}. Обновите очередь`)
    }

    const prize = prizePoints ?? r.prizePoints
    // Опечатка в знаке превратила бы штраф в бонус и наоборот.
    if (prize !== 0 && r.prizePoints !== 0 && Math.sign(prize) !== Math.sign(r.prizePoints)) {
      throw ApiError.badRequest(r.prizePoints < 0 ? 'Это штраф — баллы со знаком минус' : 'Это начисление — баллы без минуса')
    }
    const level = levelPoints ?? (prizePoints !== undefined && r.prizePoints === r.levelPoints ? prize : r.levelPoints)
    if (prize === 0 && level === 0) throw ApiError.badRequest('Ноль баллов начислять незачем — нажмите «Не начислять»')

    const inThisMonth = monthKeyOf(r.occurredAt) === currentMonthKey(now)
    const occurredAt = inThisMonth ? r.occurredAt : now
    const assignment = await assignmentAt(r.userId, occurredAt, tx)
    const nights = r.nights.length > 1 ? `Просрочено ночей: ${r.nights.length}` : null
    const event = await tx.motivationEvent.create({
      data: {
        userId: r.userId,
        profileId: assignment?.profileId ?? null,
        eventTypeId: r.eventTypeId,
        kind: 'event',
        mode: 'auto',
        title: r.title,
        prizePoints: prize,
        levelPoints: level,
        taskId: r.taskId,
        taskTitle: r.taskTitle,
        comment: [comment?.trim(), nights].filter(Boolean).join('. ') || null,
        occurredAt,
        dedupeKey: `review:${r.rule}:${r.id}`,
        createdById: actor.id,
      },
    })
    return tx.motivationReview.update({
      where: { id: r.id },
      data: { status: 'approved', decidedById: actor.id, decidedAt: now, eventId: event.id, decisionNote: comment?.trim() || null },
      include: INCLUDE,
    })
  })
  return reviewCard(review)
}

/** «Не начислять». Причина необязательна, но остаётся в решённых. */
export async function rejectReview(actor, id, { reason } = {}, now = new Date()) {
  assertAdmin(actor, 'Решать по заявкам может только владелец')
  const first = await prisma.motivationReview.findUnique({ where: { id }, select: { userId: true } })
  if (!first) throw ApiError.notFound('Заявка не найдена')

  const review = await prisma.$transaction(async (tx) => {
    await lockUser(tx, first.userId)
    const r = await loadPending(tx, id)
    if (r.status === 'rejected') return r
    assertStillPending(r)
    return tx.motivationReview.update({
      where: { id: r.id },
      data: { status: 'rejected', decidedById: actor.id, decidedAt: now, decisionNote: reason?.trim() || null },
      include: INCLUDE,
    })
  })
  return reviewCard(review)
}
