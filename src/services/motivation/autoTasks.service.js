import { prisma } from '../../config/prisma.js'
import { PARTICIPANT_ROLES } from './access.js'
import { currentMonthKey, monthRange } from './month.js'
import { assignmentAt, getSettingsRow } from './profiles.js'
import {
  autoActiveAt, autoKey, autoKeyPrefix, capGain, capPenalty, isOnTime,
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
 * Записи автоматические: без автора, с режимом auto. Владелец может
 * отменить любую из них в карточке человека, как и ручную.
 */

const RETURNED_REASON = 'Задачу вернули из «Готово»'

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
// не должны оба уложиться в один и тот же остаток.
const lockUser = (tx, userId) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}))`

/**
 * Задачу закрыли в срок — баллы события «в срок» из профиля. Не больше
 * одной живой записи на задачу: закрыли, открыли, закрыли — баллы одни.
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
    const alive = await tx.motivationEvent.findFirst({
      where: { taskId: task.id, dedupeKey: { startsWith: autoKeyPrefix(rule, task.id) }, cancelledAt: null },
      select: { id: true },
    })
    if (alive) return null

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
 * причиной и остаётся в истории. Только в текущем месяце: прошлый месяц уже
 * посчитан и, возможно, выплачен.
 */
export async function revokeOnTime(task, now = new Date()) {
  const rule = ruleFor(task, 'on_time')
  const { start } = monthRange(currentMonthKey(now))
  const res = await prisma.motivationEvent.updateMany({
    where: {
      taskId: task.id,
      dedupeKey: { startsWith: autoKeyPrefix(rule, task.id) },
      cancelledAt: null,
      occurredAt: { gte: start },
    },
    data: { cancelledAt: now, cancelReason: RETURNED_REASON },
  })
  return res.count
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
 * последней московской полуночи. Из Иерархии — за каждую прошедшую ночь, до
 * лимита на задачу; личная — один раз. Пропущенные ночи доначисляются, уже
 * начисленные отсекаются ключом записи, так что звать можно сколько угодно
 * раз: ночью перед уборкой и при каждом запуске сервера.
 *
 * Отменённый владельцем штраф за сутки заново не ляжет (ключ занят), но и в
 * лимит задачи не считается.
 */
export async function chargeOverdue(now = new Date()) {
  const settings = await getSettingsRow()
  if (!settings.autoTasksFrom || !autoActiveAt(settings.autoTasksFrom, now)) return { charged: 0 }

  const tasks = await prisma.task.findMany({
    where: {
      status: { not: 'done' },
      deadline: { gte: settings.autoTasksFrom, lt: mskDayStart(now) },
      owner: { role: { in: PARTICIPANT_ROLES }, active: true },
    },
    select: { id: true, title: true, deadline: true, origin: true, ownerId: true, status: true },
    orderBy: { deadline: 'asc' },
  })

  let charged = 0
  for (const task of tasks) {
    try {
      charged += await chargeTask(task, settings, now)
    } catch (e) {
      // Одна сломанная задача не должна оставить без штрафа остальные.
      console.error('[motivation] штраф за просрочку не записался', task.id, e)
    }
  }
  return { charged }
}

async function chargeTask(task, settings, now) {
  const rule = ruleFor(task, 'overdue')
  let nights = overdueNights({ deadline: task.deadline, autoFrom: settings.autoTasksFrom, now })
  // Личная просрочка штрафуется один раз — за первую ночь.
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

      const used = await tx.motivationEvent.aggregate({
        where: { taskId: task.id, dedupeKey: { startsWith: autoKeyPrefix(rule, task.id) }, cancelledAt: null },
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
