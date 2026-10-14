import { prisma } from '../../config/prisma.js'
import { escapeHtml } from '../telegram.js'
import { mskDateStart } from '../../services/motivation/taskRules.js'
import { mskDayKey } from '../plan.js'
import { hm, short } from './format.js'

/**
 * «Что у меня на сегодня?», «мои задачи», «что по звонкам» — бот отвечает
 * сам, из CRM, без ИИ: столбиком, бесплатно и даже без ключа. ИИ такие
 * длинные списки сворачивал в сплошной абзац.
 */

const MAX_TODAY = 20
const MAX_OVERDUE = 10
const MAX_CALLS = 10
const DAY_MS = 24 * 60 * 60 * 1000

const normalize = (text) => String(text ?? '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim()

const TASKS = /((мои|какие|покажи|список)( у меня| мои)? задач|задачи на сегодня|что( у меня)? по задачам|сколько( у меня)? задач)/
const CALLS = /((мои|какие|покажи)( у меня| мои)? звонк|звонки на сегодня|что( у меня)? по звонкам|есть( ли)?( сегодня)? звонк|когда( сегодня)? звонок)/
const TODAY = /^(а )?(что|че|чего)( у меня)?( на)? сегодня\s*\??$|(что|какие планы)( у меня)? на сегодня/

/** Какой список просят: tasks, calls, today (задачи и звонки) или null. */
export function listIntent(text) {
  const t = normalize(text)
  if (!t || t.length > 120) return null
  const tasks = TASKS.test(t)
  const calls = CALLS.test(t) || (tasks && /звонк/.test(t))
  if (tasks && !calls) return 'tasks'
  if (calls && !tasks) return 'calls'
  if (tasks || TODAY.test(t)) return 'today'
  return null
}

const dateShort = (date) => new Date(date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'Europe/Moscow' })
const title = (t) => escapeHtml(short(t.title, 80))

function todayLine(t, now) {
  const parts = [title(t)]
  if (t.startAt && t.status === 'today') parts.push(`начало ${hm(t.startAt)}`)
  parts.push(`до ${hm(t.deadline)}`)
  if (t.status === 'progress') parts.push('в процессе')
  if (t.deadline < now) parts.push('срок прошёл')
  return `• ${parts.join(', ')}`
}

/** Задачи: на сегодня, сколько позже, просроченные. */
export async function tasksText(userId, now = new Date()) {
  const dayStart = mskDateStart(mskDayKey(now))
  const dayEnd = new Date(dayStart.getTime() + DAY_MS)
  const active = { ownerId: userId, status: { in: ['today', 'progress'] } }
  const TASK = { title: true, status: true, deadline: true, startAt: true }
  const [today, todayCount, laterCount, overdue, overdueCount] = await Promise.all([
    prisma.task.findMany({ where: { ...active, deadline: { gte: dayStart, lt: dayEnd } }, orderBy: { deadline: 'asc' }, take: MAX_TODAY, select: TASK }),
    prisma.task.count({ where: { ...active, deadline: { gte: dayStart, lt: dayEnd } } }),
    prisma.task.count({ where: { ...active, deadline: { gte: dayEnd } } }),
    prisma.task.findMany({ where: { ...active, deadline: { lt: dayStart } }, orderBy: { deadline: 'desc' }, take: MAX_OVERDUE, select: TASK }),
    prisma.task.count({ where: { ...active, deadline: { lt: dayStart } } }),
  ])

  const blocks = []
  if (today.length) {
    const lines = [`<b>Задачи на сегодня, ${todayCount}</b>`, ...today.map((t) => todayLine(t, now))]
    if (todayCount > today.length) lines.push(`И ещё ${todayCount - today.length} в CRM, во вкладке «Задачи».`)
    blocks.push(lines.join('\n'))
  } else {
    blocks.push('<b>Задач на сегодня нет</b>')
  }
  if (laterCount) blocks.push(`Со сроком позже ещё ${laterCount}.`)
  if (overdue.length) {
    const lines = [`<b>Просроченные задачи, ${overdueCount}</b>`, ...overdue.map((t) => `• ${title(t)}, срок ${dateShort(t.deadline)}`)]
    if (overdueCount > overdue.length) lines.push(`И ещё ${overdueCount - overdue.length} в CRM, во вкладке «Задачи».`)
    blocks.push(lines.join('\n'))
  }
  return blocks.join('\n\n')
}

/** Звонки до конца дня, где человек ведущий или участник. */
export async function callsText(userId, now = new Date()) {
  const dayEnd = new Date(mskDateStart(mskDayKey(now)).getTime() + DAY_MS)
  const calls = await prisma.call.findMany({
    where: { scheduledAt: { gte: now, lt: dayEnd }, OR: [{ ownerId: userId }, { participants: { some: { id: userId } } }] },
    orderBy: { scheduledAt: 'asc' },
    take: MAX_CALLS,
    select: { title: true, scheduledAt: true },
  })
  if (!calls.length) return '<b>Звонков сегодня больше нет</b>'
  return [`<b>Звонки сегодня</b>`, ...calls.map((c) => `• ${hm(c.scheduledAt)} ${escapeHtml(short(c.title, 80))}`)].join('\n')
}

/** Текст ответа на просьбу показать список. */
export async function listText(kind, userId, now = new Date()) {
  if (kind === 'tasks') return tasksText(userId, now)
  if (kind === 'calls') return callsText(userId, now)
  const [tasks, calls] = await Promise.all([tasksText(userId, now), callsText(userId, now)])
  return `${tasks}\n\n${calls}`
}
