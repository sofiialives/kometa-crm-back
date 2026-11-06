import { dateShort } from '../agent/format.js'
import { staffBrief } from './context.js'
import { preflight, runAgent } from './engine.js'
import { cut, MAX_INPUT_CHARS, plain, TALK_BEGIN, TALK_END, TASKS_BEGIN, TASKS_END } from './limits.js'
import { recentRows, toMessages } from './memory.js'
import { noLinks, plainStyle } from './style.js'
import { personalNotesBlock, sharedNotesBlock } from './styleNotes.js'
import { morningReportSystem, morningSystem } from './system.js'
import { transcript } from './report.js'

/**
 * Утренний обход: два вида запросов. Сообщение человеку идёт как kind
 * 'morning', строки отчёта как 'morningReport' (на владельце, по запросу на
 * человека).
 * 1. Сообщение человеку, одним коротким запросом без инструментов, по данным
 *    только этого человека (staffBrief), как вопрос о неначатых задачах.
 * 2. Строки отчёта по каждому человеку, отдельным запросом на человека, как
 *    отчёт по поручению: слова одного не попадут в строки о другом.
 * Нет ИИ, лимит, бюджет, отказ, сбой или пустой ответ дают null, и бот
 * берёт шаблон из данных.
 */

const OFFER_WHY = {
  overdue: (o) => `она просрочена, срок был ${dateShort(o.deadline)}`,
  hierarchy: (o) => `она открыта в Иерархии${o.client ? `, клиент ${plain(o.client, 40)}` : ''}${o.work ? `, работа «${plain(o.work, 60)}»` : ''}`,
}

/** Что сказать модели о предлагаемой задаче: одна, с причиной. */
export function offerLine(offer) {
  if (!offer) return 'Предложить нечего, ничего не предлагай'
  return `Предложи ему взять задачу «${plain(offer.title, 120)}», ${OFFER_WHY[offer.why]?.(offer) ?? 'она висит'}`
}

/**
 * Утреннее сообщение человеку. user — { id, role }, offer — { title, why,
 * deadline, client, work } или null. deps подменяют базу и API в проверках.
 */
export async function morningText({ user, offer = null, now = new Date(), timeoutMs = 15_000 }, deps = {}) {
  try {
    const check = await preflight({ userId: user.id, role: user.role, kind: 'morning' }, deps)
    if (check.status !== 'ok') return null
    const [brief, rows, shared, personal] = await Promise.all([
      deps.brief ?? staffBrief(user.id, now),
      deps.rows ?? recentRows(user.id, { now }),
      deps.shared ?? sharedNotesBlock(),
      deps.personal ?? personalNotesBlock(user.id),
    ])
    const ask = `Новое сообщение для тебя от системы\nУтренний обход, напиши человеку первым про его день\n${offerLine(offer)}\nНапиши ему сообщение.`
    const res = await runAgent({
      userId: user.id,
      role: user.role,
      kind: 'morning',
      system: [morningSystem({ notes: shared }), personal || null],
      messages: toMessages(rows, [{ type: 'text', text: `Данные CRM\n${cut(brief, MAX_INPUT_CHARS)}\n\n${ask}` }]),
      maxTokens: 700,
      maxSteps: 1,
      effort: 'low',
      deadlineMs: Math.max(5000, timeoutMs),
    }, deps)
    if (res.status !== 'ok') return null
    return noLinks(plainStyle(cut(res.text, 500))) || null
  } catch (e) {
    console.error(`[агент] утреннее сообщение: ${e.name}`)
    return null
  }
}

export const MORNING_LINES_SCHEMA = {
  type: 'object',
  properties: { lines: { type: 'array', items: { type: 'string' } } },
  required: ['lines'],
  additionalProperties: false,
}

const OFFER_STATE = {
  done: 'уже сделана',
  progress: 'взята в работу',
  today: 'поставлена на сегодня',
  untouched: 'пока не тронута',
}

/** Задачи человека к отчёту словами, в рамке данных. tasks — { count, titles: [{ title, fresh }], offer: { title, state } | null }. */
export function morningTasksText(tasks) {
  const lines = [TASKS_BEGIN, `Задач на сегодня ${tasks.count}, из них поставлено после моего сообщения ${tasks.fresh ?? 0}`]
  for (const t of tasks.titles) lines.push(`- «${plain(t.title, 60)}»${t.fresh ? ', поставлена после моего сообщения' : ''}`)
  if (tasks.count > tasks.titles.length) lines.push(`и ещё ${tasks.count - tasks.titles.length}`)
  lines.push(tasks.offer ? `Предложенная задача «${plain(tasks.offer.title, 60)}», ${OFFER_STATE[tasks.offer.state] ?? 'пока не тронута'}` : 'Я ничего не предлагал')
  lines.push(TASKS_END)
  return lines.join('\n')
}

// Строки отчёта: не больше трёх людей сразу, на все вместе около минуты.
const REPORT_PARALLEL = 3
const REPORT_EACH_MS = 30_000
const REPORT_TOTAL_MS = 60_000

/**
 * Строки отчёта по каждому человеку. people — [{ id, label, tasks, messages,
 * summary }]. Каждый запрос к модели считается в лимите владельца, общее время около минуты.
 * Возвращает { [userId]: { lines, quote } } или null.
 */
export async function morningLines({ ownerId, role = 'admin', people }, deps = {}) {
  const check = await preflight({ userId: ownerId, role, kind: 'morningReport' }, deps)
  if (check.status !== 'ok') return null
  const until = Date.now() + (deps.totalMs ?? REPORT_TOTAL_MS)
  const shared = deps.sharedNotes ?? await sharedNotesBlock()
  const out = {}
  const queue = [...people]
  const worker = async () => {
    for (let p = queue.shift(); p; p = queue.shift()) {
      // Время вышло: остальным шаблон, лишних запросов нет.
      const left = until - Date.now()
      if (left < 5000) return
      try {
        const res = await runAgent({
          userId: ownerId,
          role,
          kind: 'morningReport',
          system: [morningReportSystem({ notes: shared })],
          messages: [{
            role: 'user',
            content: [{ type: 'text', text: `Человек ${p.label}${p.summary ? `. Суть от агента в разговоре «${plain(p.summary, 400)}»` : ''}.\n\n${morningTasksText(p.tasks)}\n\n${TALK_BEGIN}\n${p.messages.length ? cut(transcript(p.messages), 8000) : 'Он пока не отвечал'}\n${TALK_END}` }],
          }],
          maxTokens: 1200,
          maxSteps: 1,
          effort: 'low',
          deadlineMs: Math.min(deps.eachMs ?? REPORT_EACH_MS, left),
          format: MORNING_LINES_SCHEMA,
        }, deps)
        if (res.status !== 'ok') continue
        const lines = (res.data?.lines ?? []).map((l) => noLinks(plainStyle(cut(String(l), 300)))).filter(Boolean).slice(0, 3)
        if (lines.length) out[p.id] = { lines }
      } catch (e) {
        console.error(`[агент] строки утреннего отчёта: ${e.name}`)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(REPORT_PARALLEL, people.length) }, worker))
  return Object.keys(out).length ? out : null
}
