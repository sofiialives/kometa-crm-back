import { prisma } from '../../config/prisma.js'
import { escapeHtml } from '../telegram.js'
import { mskDateStart } from '../../services/motivation/taskRules.js'
import { mskDayKey } from '../plan.js'
import { hm, short } from './format.js'
import { dueText, tasksOf } from './taskScope.js'

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

// Задачи отдела, команды, ребят: их без ИИ не собрать.
const TEAM = /(отдел|команд|ребят|коллег|сотрудник|специалист)/
const TEAM_TEXT = 'Список по отделу собирает агент, а он сейчас недоступен\nСвои задачи покажу, спроси «мои задачи»'

/** Какой список просят: tasks, calls, today (задачи и звонки), team (задачи отдела) или null. */
export function listIntent(text) {
  const t = normalize(text)
  if (!t || t.length > 120) return null
  const tasks = TASKS.test(t)
  if (tasks && TEAM.test(t)) return 'team'
  const calls = CALLS.test(t) || (tasks && /звонк/.test(t))
  if (tasks && !calls) return 'tasks'
  if (calls && !tasks) return 'calls'
  if (tasks || TODAY.test(t)) return 'today'
  return null
}

const title = (t) => `«${escapeHtml(short(t.title, 80))}»`
// Личные и задачи по Иерархии — разные списки, вместе их не складываем.
const NAME = {
  personal: { today: 'Личные задачи на сегодня', overdue: 'Личные просроченные задачи', where: 'во вкладке «Задачи»', later: 'личных' },
  hierarchy: { today: 'Задачи по Иерархии на сегодня', overdue: 'Просроченные задачи по Иерархии', where: 'в Иерархии', later: 'по Иерархии' },
}
const client = (t) => (t.origin === 'hierarchy' && t.work?.client?.name ? `клиент ${escapeHtml(short(t.work.client.name, 40))}` : null)

function todayLine(t) {
  const parts = [title(t), client(t)].filter(Boolean)
  if (t.startAt && t.status === 'today') parts.push(`начало ${hm(t.startAt)}`)
  parts.push(`до ${hm(t.deadline)}`)
  if (t.status === 'progress') parts.push('в процессе')
  return parts.join(', ')
}

/**
 * Задачи: на сегодня, сколько позже, просроченные. Личные и по Иерархии
 * раздельно; просрочена задача, как в CRM, когда срок меньше «сейчас».
 * Числа в заголовках настоящие, а список обрезан: остальное в CRM.
 */
export async function tasksText(userId, now = new Date()) {
  const sections = await tasksOf(userId, now, { today: MAX_TODAY, overdue: MAX_OVERDUE, later: 0, done: 0 })
  const blocks = []
  if (!sections.some((s) => s.counts.today)) blocks.push('<b>Задач на сегодня нет</b>')
  for (const { kind, counts, lists } of sections) {
    if (!counts.today) continue
    const lines = [`<b>${NAME[kind].today}, ${counts.today}</b>`, ...lists.today.map(todayLine)]
    if (counts.today > lists.today.length) lines.push(`и ещё ${counts.today - lists.today.length} в CRM, ${NAME[kind].where}`)
    blocks.push(lines.join('\n'))
  }
  const later = sections.filter((s) => s.counts.later).map((s) => `${NAME[s.kind].later} ${s.counts.later}`)
  if (later.length) blocks.push(`Со сроком на завтра и позже ещё ${later.join(', ')}`)
  for (const { kind, counts, lists } of sections) {
    if (!counts.overdue) continue
    const lines = [`<b>${NAME[kind].overdue}, ${counts.overdue}</b>`, ...lists.overdue.map((t) => [title(t), client(t), dueText(t, now)].filter(Boolean).join(', '))]
    if (counts.overdue > lists.overdue.length) lines.push(`и ещё ${counts.overdue - lists.overdue.length} в CRM, ${NAME[kind].where}`)
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
  return [`<b>Звонки сегодня</b>`, ...calls.map((c) => `${hm(c.scheduledAt)} ${escapeHtml(short(c.title, 80))}`)].join('\n')
}

/** Текст ответа на просьбу показать список. */
export async function listText(kind, userId, now = new Date()) {
  if (kind === 'team') return TEAM_TEXT
  if (kind === 'tasks') return tasksText(userId, now)
  if (kind === 'calls') return callsText(userId, now)
  const [tasks, calls] = await Promise.all([tasksText(userId, now), callsText(userId, now)])
  return `${tasks}\n\n${calls}`
}
