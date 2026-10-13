import { prisma } from '../../config/prisma.js'
import { PARTICIPANT_ROLES } from './access.js'
import { currentMonthKey, monthRange } from './month.js'
import { assignmentAt, getSettingsRow } from './profiles.js'
import {
  autoActiveAt, autoKey, autoKeyPrefix, capGain, capPenalty, estimateComplexity, isOnTime,
  mskDayStart, overdueNights, ruleFor,
} from './taskRules.js'

/**
 * Автобаллы за задачи (этап 2). Правила — в taskRules.js, здесь только
 * данные и записи в журнал баллов.
 *
 * Кто пишет сюда:
 * - task.service.js после смены статуса задачи — баллы «в срок» и их снятие;
 * - ночная уборка задач (jobs/clearFinishedTasks.job.js) перед удалением и
 *   запуск сервера — штрафы за просрочку.
 *
 * Два режима (MotivationSettings.taskPointsMode):
 * - review (по умолчанию) — баллы не начисляются, а ложатся заявкой в
 *   очередь «На проверке» с подсказанными баллами; начисляет владелец
 *   (review.service.js). Так заказчик хочет на время проверки системы;
 * - auto — баллы ложатся в журнал сами, без автора, с режимом auto.
 * Владелец может отменить любую запись в карточке человека, как и ручную.
 */

const RETURNED_REASON = 'Задачу вернули из «Готово»'

// Запись занимает место, если она живая или её отменил человек — см.
// holdsSlot в taskRules.js. Отменённая системой место освобождает.
const HOLDS_SLOT = { OR: [{ cancelledAt: null }, { cancelledById: { not: null } }] }

// То же для заявок: ждёт решения, начислена или отклонена владельцем —
// место занято. Снятая системой (вернули из «Готово») — свободно.
const REVIEW_TAKEN = ['pending', 'approved', 'rejected']

const reviewMode = (settings) => settings.taskPointsMode !== 'auto'

// Записи задачи по правилу: автоматические и начисленные по заявкам.
const slotOf = (rule, taskId) => ({
  OR: [{ dedupeKey: { startsWith: autoKeyPrefix(rule, taskId) } }, { review: { rule } }],
})

function reviewData({ task, rule, type, prizePoints, levelPoints, at, key, nights = [] }) {
  return {
    userId: task.ownerId,
    rule,
    eventTypeId: type.id,
    title: type.title,
    prizePoints,
    levelPoints,
    taskId: task.id,
    taskTitle: task.title,
    taskDescription: task.description ?? null,
    taskDeadline: task.deadline,
    // Сложность подсказываем для личных задач: их человек ставит себе сам.
    complexity: task.origin === 'personal' ? estimateComplexity(task) : null,
    nights,
    occurredAt: at,
    dedupeKey: `review:${rule}:${task.id}:${key}`,
  }
}

/**
 * Событие профиля, по которому начисляются баллы, или null, если начислять
 * нечего: автобаллы выключены или ещё не начались, человек не участвует в
 * мотивации (владелец, отключённый), профиля нет или событие в нём
 * выключено. Профиль берётся на момент самого события.
 */
async function autoEventType(ownerId, rule, at, settings, db = prisma) {
  if (!autoActiveAt(settings.autoTasksFrom, at)) return null
  const owner = await db.user.findUnique({ where: { id: ownerId }, select: { role: true, active: true } })
  if (!owner?.active || !PARTICIPANT_ROLES.includes(owner.role)) return null
  const assignment = await assignmentAt(ownerId, at, db)
  const profile = assignment?.profile
  const type = profile?.eventTypes.find((e) => e.mode === 'auto' && e.autoRule === rule && e.enabled)
  return type ? { type, profile } : null
}

function autoEventData({ task, rule, type, profile, prizePoints, levelPoints, at, key }) {
  return {
    userId: task.ownerId,
    profileId: profile.id,
    eventTypeId: type.id,
    kind: 'event',
    mode: 'auto',
    title: type.title,
    prizePoints,
    levelPoints,
    taskId: task.id,
    taskTitle: task.title,
    occurredAt: at,
    dedupeKey: autoKey(rule, task.id, key),
  }
}

// Все автозаписи человека проходят под одним замком на человека — тем же,
// что и списание: лимиты считаются по журналу, и два параллельных закрытия
// не должны оба уложиться в один и тот же остаток. Под тем же замком —
// снятие баллов при возврате из «Готово», чтобы «закрыл» и «вернул»,
// пришедшие почти одновременно, не разминулись.
const lockUser = (tx, userId) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}))`

/**
 * Задачу закрыли в срок — баллы события «в срок» из профиля. Не больше
 * одной записи на задачу: закрыли, открыли, закрыли — баллы одни. Если
 * баллы за эту задачу снял владелец, второй раз они не начислятся.
 * Для личных задач — с дневным потолком из настроек.
 */
export async function awardOnTime(task, settings) {
  if (!isOnTime(task)) return null
  const rule = ruleFor(task, 'on_time')
  const at = new Date(task.doneAt)
  const found = await autoEventType(task.ownerId, rule, at, settings)
  if (!found) return null
  const { type, profile } = found

  return prisma.$transaction(async (tx) => {
    await lockUser(tx, task.ownerId)
    // Пока ждали замка, задачу могли вернуть из «Готово» — тогда баллов нет.
    const fresh = await tx.task.findUnique({ where: { id: task.id }, select: { status: true, doneAt: true } })
    if (fresh?.status !== 'done' || fresh.doneAt?.getTime() !== at.getTime()) return null

    // Место занято и автоматической записью, и начисленной по заявке: при
    // переключении режима «на проверку → автоматически» баллы не задвоятся.
    const taken = await tx.motivationEvent.findFirst({
      where: { taskId: task.id, AND: [HOLDS_SLOT, slotOf(rule, task.id)] },
      select: { id: true },
    })
    if (taken) return null

    if (reviewMode(settings)) {
      // Заявка на проверку: одна на задачу, пока её не сняла система.
      // Дневной потолок личных задач здесь не режет — его видит владелец.
      const queued = await tx.motivationReview.findFirst({
        where: { taskId: task.id, rule, status: { in: REVIEW_TAKEN } },
        select: { id: true },
      })
      if (queued) return null
      return tx.motivationReview.create({
        data: reviewData({ task, rule, type, prizePoints: type.prizePoints, levelPoints: type.levelPoints, at, key: at.getTime() }),
      })
    }

    let prizePoints = type.prizePoints
    let levelPoints = type.levelPoints
    if (rule === 'personal_task_on_time') {
      // Дневной потолок — по московским суткам закрытия.
      const dayStart = mskDayStart(at)
      const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000)
      const used = await tx.motivationEvent.aggregate({
        where: {
          userId: task.ownerId,
          dedupeKey: { startsWith: `auto:${rule}:` },
          cancelledAt: null,
          occurredAt: { gte: dayStart, lt: dayEnd },
        },
        _sum: { prizePoints: true, levelPoints: true },
      })
      prizePoints = capGain(prizePoints, used._sum.prizePoints ?? 0, settings.personalTaskDailyCap)
      levelPoints = capGain(levelPoints, used._sum.levelPoints ?? 0, settings.personalTaskDailyCap)
      // Потолок на сегодня выбран — записи нет: пустая строка «+0» в
      // истории только путала бы. Потолок написан в «Моих условиях».
      if (prizePoints === 0 && levelPoints === 0) return null
    }

    return tx.motivationEvent.create({
      data: autoEventData({ task, rule, type, profile, prizePoints, levelPoints, at, key: at.getTime() }),
    })
  })
}

/**
 * Задачу вернули из «Готово» — баллы за срок снимаются: запись отменяется с
 * причиной и остаётся в истории. Отменяет система, автора у отмены нет —
 * поэтому, закрыв задачу снова в срок, человек получит баллы снова. Только
 * в текущем месяце: прошлый месяц уже посчитан и, возможно, выплачен.
 */
export async function revokeOnTime(task, now = new Date()) {
  const rule = ruleFor(task, 'on_time')
  const { start } = monthRange(currentMonthKey(now))
  return prisma.$transaction(async (tx) => {
    await lockUser(tx, task.ownerId)
    const res = await tx.motivationEvent.updateMany({
      where: {
        taskId: task.id,
        dedupeKey: { startsWith: autoKeyPrefix(rule, task.id) },
        cancelledAt: null,
        occurredAt: { gte: start },
      },
      data: { cancelledAt: now, cancelReason: RETURNED_REASON },
    })

    // Заявка ещё ждёт — снимаем её. Уже начисленная по заявке — отменяем
    // баллы так же, как автоматические, и помечаем заявку снятой.
    const withdrawn = await tx.motivationReview.updateMany({
      where: { taskId: task.id, rule, status: 'pending' },
      data: { status: 'withdrawn', decisionNote: RETURNED_REASON, decidedAt: now },
    })
    const approved = await tx.motivationReview.findMany({
      where: { taskId: task.id, rule, status: 'approved', event: { cancelledAt: null, occurredAt: { gte: start } } },
      select: { id: true, eventId: true, decisionNote: true },
    })
    if (approved.length) {
      await tx.motivationEvent.updateMany({
        where: { id: { in: approved.map((a) => a.eventId) } },
        data: { cancelledAt: now, cancelReason: RETURNED_REASON },
      })
      // Заметку владельца не затираем — дописываем причину.
      for (const a of approved) {
        await tx.motivationReview.update({
          where: { id: a.id },
          data: { status: 'withdrawn', decisionNote: a.decisionNote ? `${a.decisionNote}. ${RETURNED_REASON}` : RETURNED_REASON },
        })
      }
    }
    return res.count + withdrawn.count + approved.length
  })
}

/**
 * Вызывается после смены статуса задачи. Никогда не бросает: задача должна
 * переехать в колонку, даже если с баллами что-то пошло не так, — ошибка
 * уходит в лог.
 */
export async function syncTaskStatus(before, after, now = new Date()) {
  try {
    if (before.status === after.status) return
    if (after.status === 'done') {
      const settings = await getSettingsRow()
      await awardOnTime(after, settings)
    } else if (before.status === 'done') {
      await revokeOnTime(after, now)
    }
  } catch (e) {
    console.error('[motivation] баллы за задачу не записались', after?.id, e)
  }
}

/**
 * Штрафы за просрочку на «сейчас»: каждая незакрытая задача со сроком до
 * последней московской полуночи. Из Иерархии — за каждую ещё не
 * проверенную ночь, до лимита на задачу; личная — один раз. Звать можно
 * сколько угодно раз — ночью перед уборкой и при каждом запуске сервера:
 * повтор отсекается ключом записи, а проверенные ночи отмечаются в
 * настройках (overdueCheckedUntil) и второй раз не разбираются.
 *
 * Возвращает, сколько штрафов легло, и задачи, по которым запись не
 * удалась: уборка их не удаляет, чтобы личная просрочка не ушла без штрафа.
 */
export async function chargeOverdue(now = new Date()) {
  const settings = await getSettingsRow()
  if (!settings.autoTasksFrom || !autoActiveAt(settings.autoTasksFrom, now)) return { charged: 0, failed: [] }

  const lastMidnight = mskDayStart(now)
  const tasks = await prisma.task.findMany({
    where: {
      status: { not: 'done' },
      deadline: { gte: settings.autoTasksFrom, lt: lastMidnight },
      owner: { role: { in: PARTICIPANT_ROLES }, active: true },
    },
    select: { id: true, title: true, description: true, deadline: true, origin: true, ownerId: true, status: true },
    orderBy: { deadline: 'asc' },
  })

  let charged = 0
  const failed = []
  for (const task of tasks) {
    try {
      charged += await chargeTask(task, settings, now)
    } catch (e) {
      // Одна сломанная задача не должна оставить без штрафа остальные.
      failed.push(task.id)
      console.error('[motivation] штраф за просрочку не записался', task.id, e)
    }
  }

  // Ночи до последней полуночи разобраны. Только вперёд: параллельный
  // проход с более ранним «сейчас» отметку не откатит.
  await prisma.motivationSettings.updateMany({
    where: { id: 'global', OR: [{ overdueCheckedUntil: null }, { overdueCheckedUntil: { lt: lastMidnight } }] },
    data: { overdueCheckedUntil: lastMidnight },
  })
  return { charged, failed }
}

async function chargeTask(task, settings, now) {
  if (reviewMode(settings)) return proposeOverdue(task, settings, now)
  const rule = ruleFor(task, 'overdue')
  let nights = overdueNights({
    deadline: task.deadline,
    autoFrom: settings.autoTasksFrom,
    checkedUntil: settings.overdueCheckedUntil,
    now,
  })
  // Личная просрочка штрафуется один раз — за первую же разобранную ночь.
  if (rule === 'personal_task_overdue') nights = nights.slice(0, 1)

  let charged = 0
  for (const night of nights) {
    const found = await autoEventType(task.ownerId, rule, night.at, settings)
    if (!found) continue
    const { type, profile } = found
    const key = rule === 'personal_task_overdue' ? 'once' : night.dayKey

    const created = await prisma.$transaction(async (tx) => {
      await lockUser(tx, task.ownerId)
      const dedupeKey = autoKey(rule, task.id, key)
      if (await tx.motivationEvent.findUnique({ where: { dedupeKey }, select: { id: true } })) return 'exists'

      // В лимит идут и штрафы, прощённые владельцем, и начисленные по
      // заявкам: иначе следующая ночь молча вернула бы то, что он простил,
      // а смена режима — превысила бы лимит.
      const used = await tx.motivationEvent.aggregate({
        where: { taskId: task.id, AND: [HOLDS_SLOT, slotOf(rule, task.id)] },
        _sum: { prizePoints: true, levelPoints: true },
      })
      const prizePoints = capPenalty(type.prizePoints, -(used._sum.prizePoints ?? 0), settings.overduePenaltyCap)
      const levelPoints = capPenalty(type.levelPoints, -(used._sum.levelPoints ?? 0), settings.overduePenaltyCap)
      // Лимит на задачу выбран — дальше ночи можно не смотреть.
      if (prizePoints === 0 && levelPoints === 0) return 'capped'

      await tx.motivationEvent.create({
        data: autoEventData({ task, rule, type, profile, prizePoints, levelPoints, at: night.at, key }),
      })
      return 'created'
    })
    if (created === 'capped') break
    if (created === 'created') charged += 1
  }
  return charged
}

/**
 * Просрочка в режиме проверки: вместо штрафа — заявка владельцу. У задачи
 * из Иерархии каждая ночь добавляет штраф в одну ждущую заявку («просрочено
 * 3 ночи, снять 6»), пока владелец не решит; лимит на задачу тот же, в него
 * идут и уже начисленные по заявкам штрафы. Личная просрочка — одна заявка.
 * Отклонил владелец заявку по задаче — больше по ней не предлагаем.
 */
async function proposeOverdue(task, settings, now) {
  const rule = ruleFor(task, 'overdue')
  let nights = overdueNights({
    deadline: task.deadline,
    autoFrom: settings.autoTasksFrom,
    checkedUntil: settings.overdueCheckedUntil,
    now,
  })
  if (rule === 'personal_task_overdue') nights = nights.slice(0, 1)

  let proposed = 0
  for (const night of nights) {
    const found = await autoEventType(task.ownerId, rule, night.at, settings)
    if (!found) continue
    const { type } = found

    const outcome = await prisma.$transaction(async (tx) => {
      await lockUser(tx, task.ownerId)
      const reviews = await tx.motivationReview.findMany({ where: { taskId: task.id, rule } })
      if (reviews.some((r) => r.status === 'rejected')) return 'capped'
      if (rule === 'personal_task_overdue' && reviews.some((r) => r.status !== 'withdrawn')) return 'exists'
      if (reviews.some((r) => r.nights.includes(night.dayKey))) return 'exists'

      const pending = reviews.find((r) => r.status === 'pending')
      const approved = await tx.motivationEvent.aggregate({
        where: { taskId: task.id, review: { rule, status: 'approved' }, ...HOLDS_SLOT },
        _sum: { prizePoints: true, levelPoints: true },
      })
      const automatic = await tx.motivationEvent.aggregate({
        where: { taskId: task.id, dedupeKey: { startsWith: autoKeyPrefix(rule, task.id) }, ...HOLDS_SLOT },
        _sum: { prizePoints: true, levelPoints: true },
      })
      const usedPrize = -((approved._sum.prizePoints ?? 0) + (automatic._sum.prizePoints ?? 0) + (pending?.prizePoints ?? 0))
      const usedLevel = -((approved._sum.levelPoints ?? 0) + (automatic._sum.levelPoints ?? 0) + (pending?.levelPoints ?? 0))
      const prizePoints = capPenalty(type.prizePoints, usedPrize, settings.overduePenaltyCap)
      const levelPoints = capPenalty(type.levelPoints, usedLevel, settings.overduePenaltyCap)
      if (prizePoints === 0 && levelPoints === 0) return 'capped'

      if (pending && rule === 'task_overdue') {
        await tx.motivationReview.update({
          where: { id: pending.id },
          data: {
            prizePoints: pending.prizePoints + prizePoints,
            levelPoints: pending.levelPoints + levelPoints,
            nights: { push: night.dayKey },
            occurredAt: night.at,
          },
        })
      } else {
        await tx.motivationReview.create({
          data: reviewData({
            task, rule, type, prizePoints, levelPoints, at: night.at,
            key: rule === 'personal_task_overdue' ? 'once' : night.dayKey,
            nights: [night.dayKey],
          }),
        })
      }
      return 'created'
    })
    if (outcome === 'capped') break
    if (outcome === 'created') proposed += 1
  }
  return proposed
}
