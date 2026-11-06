import { prisma } from '../../config/prisma.js'
import { mskDateStart } from '../../services/motivation/taskRules.js'
import { mskDayKey } from '../plan.js'
import { dateShort, hm } from './format.js'

/**
 * Какие задачи агент считает задачами человека и как о них говорит. Одни и
 * те же правила для агента (ai/context.js) и для списков без ИИ (lists.js),
 * чтобы число в ответе всегда было тем, что человек видит в CRM.
 *
 * - Задачи человека это задачи с его ownerId. Личные (origin personal) и из
 *   Иерархии (origin hierarchy) считаются раздельно и никогда вместе.
 * - Задача Иерархии видна, только пока есть её работа и она active. Работу
 *   закрыли, архивировали или удалили (workId обнулился) — в CRM этой задачи
 *   уже нет, и агент о ней молчит.
 * - Просрочена, как в CRM: не сделана и срок меньше «сейчас» (task.service.js).
 */

const DAY_MS = 24 * 60 * 60 * 1000
const OPEN = { in: ['today', 'progress'] }

export const KINDS = ['personal', 'hierarchy']
export const KIND_TITLE = { personal: 'Личные задачи', hierarchy: 'Задачи по Иерархии' }

/** Видна в CRM: личная или из Иерархии с работой в статусе active. */
export const VISIBLE = { OR: [{ origin: 'personal' }, { origin: 'hierarchy', work: { status: 'active' } }] }

export function dayBounds(now) {
  const start = mskDateStart(mskDayKey(now))
  return { start, end: new Date(start.getTime() + DAY_MS) }
}

/**
 * Условие на задачу по смыслу слова. Всё, что не сделано, делится по сроку
 * на три части: просрочена, на сегодня, на завтра и позже.
 */
export function metricWhere(metric, now) {
  const { start, end } = dayBounds(now)
  if (metric === 'overdue') return { status: OPEN, deadline: { lt: now } }
  if (metric === 'today') return { status: OPEN, deadline: { gte: now, lt: end } }
  if (metric === 'later') return { status: OPEN, deadline: { gte: end } }
  if (metric === 'progress') return { status: 'progress' }
  // Не начата и срок не позже сегодняшнего: с завтрашним сроком это «на завтра».
  if (metric === 'notStarted') return { status: 'today', deadline: { lt: end } }
  if (metric === 'done') return { status: 'done', doneAt: { gte: start } }
  throw new Error(`Нет такого счёта: ${metric}`)
}

/**
 * Не закрыта и срок сегодня, даже если час уже прошёл. Это шире 'today' в
 * metricWhere, где срок ещё впереди: к вечернему звонку просроченная утром
 * задача тоже «осталась на сегодня».
 */
export function dueTodayWhere(now) {
  const { start, end } = dayBounds(now)
  return { status: OPEN, deadline: { gte: start, lt: end } }
}

const METRICS = ['overdue', 'today', 'later', 'progress', 'notStarted', 'done']
const emptyCounts = () => ({ open: 0, overdue: 0, today: 0, later: 0, progress: 0, notStarted: 0, done: 0 })

/**
 * Сколько задач у каждого, отдельно личных и из Иерархии: настоящие числа
 * через groupBy, а не длина обрезанного списка. open это всё, что не сделано,
 * числа overdue/today/later его делят, progress и notStarted считаются по
 * статусу и с ними пересекаются.
 * Возвращает Map: ownerId → { personal: {...}, hierarchy: {...} }.
 */
export async function taskCounts(ownerIds, now = new Date()) {
  const ids = [...new Set(ownerIds)]
  const result = new Map(ids.map((id) => [id, { personal: emptyCounts(), hierarchy: emptyCounts() }]))
  if (!ids.length) return result
  const groups = await Promise.all(METRICS.map((m) => prisma.task.groupBy({
    by: ['ownerId', 'origin'],
    where: { AND: [VISIBLE, { ownerId: { in: ids } }, metricWhere(m, now)] },
    _count: true,
  })))
  METRICS.forEach((metric, i) => {
    for (const g of groups[i]) {
      const counts = result.get(g.ownerId)?.[g.origin]
      if (counts) counts[metric] = g._count
    }
  })
  for (const person of result.values()) {
    for (const kind of KINDS) person[kind].open = person[kind].overdue + person[kind].today + person[kind].later
  }
  return result
}

export const TASK_SELECT = {
  id: true, title: true, status: true, deadline: true, startAt: true, doneAt: true, origin: true, ownerId: true,
  work: { select: { title: true, client: { select: { name: true } } } },
}

const ORDER = { overdue: { deadline: 'desc' }, today: { deadline: 'asc' }, later: { deadline: 'asc' }, done: { doneAt: 'desc' } }

/** Список задач одного вида по смыслу слова (overdue, today, later, done), не длиннее take. */
export function taskList(ownerId, kind, metric, now, take) {
  return prisma.task.findMany({
    where: { AND: [VISIBLE, { ownerId, origin: kind }, metricWhere(metric, now)] },
    orderBy: ORDER[metric],
    take,
    select: TASK_SELECT,
  })
}

export const BLOCKS = ['overdue', 'today', 'later', 'done']

/**
 * Задачи человека, разложенные по видам: [{ kind, counts, lists }]. Список
 * запрашиваем, только когда по счёту в нём что-то есть и take для него не 0.
 * take — сколько строк в каждом списке, по ключам BLOCKS.
 */
export async function tasksOf(ownerId, now, take) {
  const counts = (await taskCounts([ownerId], now)).get(ownerId)
  return Promise.all(KINDS.map(async (kind) => {
    const lists = {}
    await Promise.all(BLOCKS.map(async (block) => {
      lists[block] = counts[kind][block] && take[block] ? await taskList(ownerId, kind, block, now, take[block]) : []
    }))
    return { kind, counts: counts[kind], lists }
  }))
}

/** Просрочена, как в CRM: не сделана и срок прошёл. */
export const isOverdue = (task, now) => task.status !== 'done' && new Date(task.deadline) < now

/** «на завтра» или «на 7 ноября» — для срока в один из будущих дней. */
export function dayWord(deadline, now) {
  const { end } = dayBounds(now)
  const d = new Date(deadline)
  return d >= end && d < new Date(end.getTime() + DAY_MS) ? 'на завтра' : `на ${dateShort(d)}`
}

/**
 * Как называется состояние задачи. Личная: «не начата» или «в процессе».
 * Из Иерархии: «открыта», в интерфейсе там только переключатель готово и
 * в процессе, а статус today значит просто «открыта». Срок в будущие дни
 * называем «на завтра» или «на 7 ноября», такая задача не «не начата».
 */
export function stateWord(task, now) {
  if (task.status === 'done') return 'сделана'
  if (task.status === 'today' && new Date(task.deadline) >= dayBounds(now).end) return dayWord(task.deadline, now)
  if (task.status === 'progress') return 'в процессе'
  return task.origin === 'hierarchy' ? 'открыта' : 'не начата'
}

/** Срок словами. У задачи «на завтра» состояние уже назвало день — только время. */
export function dueText(task, now) {
  const d = new Date(task.deadline)
  const time = hm(d)
  const { start, end } = dayBounds(now)
  if (task.status === 'today' && d >= end) return `до ${time}`
  if (d >= start && d < end) return `срок сегодня ${time}`
  if (d >= end && d < new Date(end.getTime() + DAY_MS)) return `срок завтра ${time}`
  return `срок ${dateShort(d)}`
}
