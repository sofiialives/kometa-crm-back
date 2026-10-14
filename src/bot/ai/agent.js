import { prisma } from '../../config/prisma.js'
import { parseUntil } from '../parse.js'
import { escapeHtml } from '../telegram.js'
import { comeBack, dayEnd, MENU, runningLate, startBreak } from '../agent/away.js'
import { nameOf, tellChat, tellOwners } from '../agent/notify.js'
import { isQuietHour, mskDayKey } from '../plan.js'
import { aiEnabled, askJson, hasAiBudget } from './client.js'
import { cut, MAX_OUTPUT_TOKENS_OWNER } from './limits.js'
import { ownerContext, recentHistory, staffContext } from './context.js'
import { OWNER_SCHEMA, ownerPrompt, STAFF_SCHEMA, staffPrompt, TASK_SCHEMA, taskPrompt } from './prompts.js'

/**
 * ИИ в боте. Включается, только когда правила (parse.js) не поняли
 * человека: «отхожу на 30 минут» и кнопки работают без ИИ и бесплатно.
 * ИИ понимает текст и пишет ответ, а действие выполняет бот теми же
 * функциями, что и по правилам. Нет ключа, лимит, сбой — false, и бот
 * отвечает как раньше.
 */

const MAX_BREAK_MIN = 8 * 60
const REPLY_MAX = 700
const OWNER_REPLY_MAX = 1500
const NOTE_EVERY_MS = 10 * 60000
const NOTES_PER_DAY = 5

/** До какого времени: «ЧЧ:ММ» от ИИ или «через N минут». */
export function untilFrom({ until, minutes }, now = new Date()) {
  if (until && /^\d{1,2}[:.]\d{2}$/.test(until.trim())) {
    const at = parseUntil(`до ${until.trim()}`, now)
    if (at) return at
  }
  if (Number.isInteger(minutes) && minutes > 0 && minutes <= MAX_BREAK_MIN) {
    return new Date(new Date(now).getTime() + minutes * 60000)
  }
  return null
}

/**
 * Что сделать по ответу ИИ — без базы и телеграма. kind: act — действие
 * сразу (отлучка, возвращение, задержка); confirm — сначала спросить
 * кнопкой (конец дня и форс-мажор меняют чек-ин и штрафы, а ИИ может
 * ошибиться); say — только ответ; none — ответить нечего, пусть будет
 * подсказка как без ИИ.
 */
export function decide(out, now = new Date()) {
  const reply = String(out?.reply ?? '').trim()
  const ownerNote = String(out?.owner_note ?? '').trim() || null
  const until = untilFrom(out ?? {}, now)
  switch (out?.action) {
    case 'away':
    case 'back':
    case 'late':
      return { kind: 'act', action: out.action, until, reply, ownerNote: null }
    case 'force_majeure':
    case 'day_end':
      return { kind: 'confirm', action: out.action, until, reply, ownerNote: null }
    case 'report':
      return { kind: 'say', action: 'report', reply: '', ownerNote }
    case 'question':
    case 'smalltalk':
      if (!reply && !ownerNote) return { kind: 'none' }
      return { kind: 'say', action: out.action, reply, ownerNote }
    default:
      return { kind: 'none' }
  }
}

const say = (user, chatId, text, opts = {}, max = REPLY_MAX) => tellChat(chatId, escapeHtml(cut(text, max)), { userId: user.id, ...opts })

/** Без ссылок и упоминаний: телеграм делает их кликабельными. */
export function noLinks(text) {
  return String(text ?? '')
    .replace(/https?:\/\/\S+/gi, '[ссылка]')
    .replace(/\b(?:t\.me|telegram\.me|www\.)\S*/gi, '[ссылка]')
    .replace(/@\w{3,}/g, '[упоминание]')
}

/**
 * Важное — Яну: не ночью, не чаще раза в 10 минут и не больше пяти в день
 * от человека. true — ушло.
 */
async function noteToOwner(user, note, text, now = new Date()) {
  if (isQuietHour(now)) return false
  const day = mskDayKey(now)
  const today = await prisma.botNotice.findMany({ where: { key: { startsWith: `ai-note:${user.id}:${day}:` } }, select: { sentAt: true } })
  if (today.length >= NOTES_PER_DAY) return false
  if (today.some((n) => Date.now() - n.sentAt.getTime() < NOTE_EVERY_MS)) return false
  await prisma.botNotice.create({ data: { key: `ai-note:${user.id}:${day}:${today.length + 1}` } })
  const res = await tellOwners(
    `💬 <b>${nameOf(user)}</b> — пересказ ИИ: ${escapeHtml(noLinks(cut(note, 300)))}\n<i>Сообщение: «${escapeHtml(noLinks(cut(text, 300)))}»</i>`,
  )
  return res.ok
}

/**
 * Сообщение сотрудника (или руководителя отдела), которое правила не
 * поняли. kind — own (своё) или reply (ответ на вопрос бота), extend —
 * человек отвечает на «до скольки задерживаешься?». true — ИИ разобрался
 * и бот ответил; false — пусть бот ответит как без ИИ.
 */
export async function aiStaffText(user, chatId, text, logged, now = new Date(), { kind = 'own', extend = false } = {}) {
  if (!aiEnabled() || !text) return false
  try {
    if (!(await hasAiBudget(user.id, kind))) return false
    const [context, history] = await Promise.all([staffContext(user.id, now), recentHistory(user.id, logged?.id, { take: 4 })])
    const out = await askJson({ userId: user.id, kind, ...staffPrompt({ context, history, message: text }), schema: STAFF_SCHEMA }, now)
    const plan = decide(out, now)
    if (plan.kind === 'none') return false

    if (plan.kind === 'act') {
      if (plan.action === 'away') await startBreak(user, { until: plan.until, note: text, extend }, now)
      else if (plan.action === 'back') await comeBack(user, now)
      else await runningLate(user, { until: plan.until, text }, now)
      return true
    }
    if (plan.kind === 'confirm') {
      // Сообщение человека — в кнопке, чтобы заявка на форс-мажор ушла с его словами.
      const question = plan.action === 'day_end'
        ? 'Правильно понял — на сегодня всё, заканчиваешь рабочий день?'
        : 'Похоже на форс-мажор. Передать Яну заявку, чтобы он отметил?'
      await tellChat(chatId, question, {
        userId: user.id,
        buttons: [[
          { text: 'Да', data: plan.action === 'day_end' ? 'ai:de' : `ai:fm:${logged.id}` },
          { text: 'Нет', data: 'ai:no' },
        ]],
      })
      return true
    }
    // «Передал Яну» — только если правда передали, а не со слов модели.
    if (plan.action === 'report') {
      const sent = plan.ownerNote ? await noteToOwner(user, plan.ownerNote, text, now) : false
      await say(user, chatId, sent ? 'Понял, передал Яну.' : 'Понял, записал. Если срочно — напиши Яну напрямую.')
      return true
    }
    if (plan.reply) await say(user, chatId, plan.reply)
    if (plan.ownerNote) await noteToOwner(user, plan.ownerNote, text, now)
    return true
  } catch (e) {
    console.error('[ИИ] сообщение:', e.message)
    return false
  }
}

/** Вопрос Яна о команде. Только чтение: бот ничего не меняет. */
export async function aiOwnerText(user, chatId, text, logged, now = new Date()) {
  // Сводка по команде — только владельцу.
  if (user?.role !== 'admin' || !aiEnabled() || !text) return false
  try {
    if (!(await hasAiBudget(user.id, 'own'))) return false
    const [context, history] = await Promise.all([ownerContext(now), recentHistory(user.id, logged?.id, { ownOnly: true, take: 4 })])
    const out = await askJson({ userId: user.id, kind: 'own', ...ownerPrompt({ context, history, message: text }), schema: OWNER_SCHEMA, maxTokens: MAX_OUTPUT_TOKENS_OWNER }, now)
    const reply = String(out?.reply ?? '').trim()
    if (!reply) return false
    await say(user, chatId, reply, {}, OWNER_REPLY_MAX)
    return true
  } catch (e) {
    console.error('[ИИ] вопрос владельца:', e.message)
    return false
  }
}

/**
 * Сложность личной задачи по смыслу — для подсказки в «На проверке».
 * Один раз на заявку (ключ в BotNotice), не вышло — остаётся оценка по
 * длине описания. Никогда не бросает: рассылка заявок важнее оценки.
 */
export async function aiRateReview(review) {
  if (!aiEnabled() || !review.taskTitle || !review.complexity) return review.complexity
  try {
    const key = `ai-rated:${review.id}`
    if (await prisma.botNotice.findUnique({ where: { key } })) return review.complexity
    await prisma.botNotice.create({ data: { key } })
    if (!(await hasAiBudget(review.userId, 'task'))) return review.complexity
    const out = await askJson({ userId: review.userId, kind: 'task', ...taskPrompt({ title: review.taskTitle, description: review.taskDescription }), schema: TASK_SCHEMA })
    if (!out?.complexity || out.complexity === review.complexity) return review.complexity
    await prisma.motivationReview.update({ where: { id: review.id }, data: { complexity: out.complexity } })
    return out.complexity
  } catch (e) {
    console.error('[ИИ] оценка задачи:', e.message)
    return review.complexity
  }
}
