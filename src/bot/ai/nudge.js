import { hm } from '../agent/format.js'
import { staffBrief } from './context.js'
import { preflight, runAgent } from './engine.js'
import { cut, MAX_INPUT_CHARS, plain } from './limits.js'
import { recentRows, toMessages } from './memory.js'
import { noLinks, plainStyle } from './style.js'
import { personalNotesBlock, sharedNotesBlock } from './styleNotes.js'
import { nudgeSystem } from './system.js'

/**
 * Вопрос «как дела?», когда задачи должны были начаться, а человек их не
 * взял. Текст пишет агент одним коротким запросом без инструментов, по
 * данным этого человека; вид запроса nudge считается в лимитах и бюджете.
 * Нет ИИ, лимит, отказ, сбой или пустой ответ дают null, и бот шлёт шаблон.
 *
 * deps подменяют базу и API в проверках: pick, can, take, record, create,
 * а также brief, rows, shared, personal.
 */
export async function nudgeText({ user, titles, startAt, minutes, now = new Date() }, deps = {}) {
  try {
    const check = await preflight({ userId: user.id, role: user.role, kind: 'nudge' }, deps)
    if (check.status !== 'ok') return null
    const [brief, rows, shared, personal] = await Promise.all([
      deps.brief ?? staffBrief(user.id, now),
      deps.rows ?? recentRows(user.id, { now }),
      deps.shared ?? sharedNotesBlock(),
      deps.personal ?? personalNotesBlock(user.id),
    ])
    const ask = `Новое сообщение для тебя от системы\nЗадачи должны были начаться в ${hm(startAt)}, прошло ${minutes} мин, человек их не взял\n${titles.map((t) => `«${plain(t, 120)}»`).join('\n')}\nНапиши ему сообщение.`
    const res = await runAgent({
      userId: user.id,
      role: user.role,
      kind: 'nudge',
      system: [nudgeSystem({ notes: shared }), personal || null],
      messages: toMessages(rows, [{ type: 'text', text: `Данные CRM\n${cut(brief, MAX_INPUT_CHARS)}\n\n${ask}` }]),
      maxTokens: 600,
      maxSteps: 1,
      effort: 'low',
      deadlineMs: 30_000,
    }, deps)
    if (res.status !== 'ok') return null
    const text = noLinks(plainStyle(cut(res.text, 500)))
    return text || null
  } catch (e) {
    console.error(`[агент] вопрос о неначатых задачах: ${e.name}`)
    return null
  }
}
