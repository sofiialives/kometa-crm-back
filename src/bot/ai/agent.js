import { prisma } from '../../config/prisma.js'
import { parseUntil } from '../parse.js'
import { escapeHtml } from '../telegram.js'
import { comeBack, dayEnd, MENU, reportForceMajeure, runningLate, startBreak } from '../agent/away.js'
import { nameOf, sendOnce, tellChat, tellOwners } from '../agent/notify.js'
import { askJson, aiEnabled } from './client.js'
import { cut } from './limits.js'
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

const say = (user, chatId, text, opts = {}) => tellChat(chatId, escapeHtml(cut(text, REPLY_MAX)), { userId: user.id, ...opts })

/**
 * Сообщение сотрудника (или руководителя отдела), которое правила не
 * поняли. kind — own (своё) или reply (ответ на вопрос бота). true — ИИ
 * разобрался и бот ответил.
 */
export async function aiStaffText(user, chatId, text, logged, now = new Date(), { kind = 'own' } = {}) {
  if (!aiEnabled() || !text) return false
  const [context, history] = await Promise.all([staffContext(user.id, now), recentHistory(user.id, logged?.id)])
  const prompt = staffPrompt({ context, history, message: text })
  const out = await askJson({ userId: user.id, kind, ...prompt, schema: STAFF_SCHEMA }, now)
  if (!out) return false

  const until = untilFrom(out, now)
  switch (out.action) {
    case 'away':
      await startBreak(user, { until, note: text }, now)
      break
    case 'back':
      await comeBack(user, now)
      break
    case 'late':
      await runningLate(user, { until, text }, now)
      break
    case 'force_majeure':
      await reportForceMajeure(user, text, logged, now)
      break
    case 'day_end':
      await dayEnd(user, now)
      break
    case 'unclear':
      await say(user, chatId, out.reply || 'Не совсем понял. Нажми кнопку или напиши по-другому:', { buttons: MENU })
      break
    default:
      // question, report, smalltalk — просто ответ.
      if (out.reply) await say(user, chatId, out.reply)
  }

  // Важное для Яна — кроме того, о чём бот и так ему пишет (отлучки,
  // задержки, форс-мажор). Не чаще раза в 10 минут от человека.
  const reported = ['away', 'late', 'force_majeure'].includes(out.action)
  if (out.owner_note && !reported) {
    const bucket = Math.floor(new Date().getTime() / (10 * 60000))
    await sendOnce(`ai-note:${user.id}:${bucket}`, () =>
      tellOwners(`💬 <b>${nameOf(user)}</b>: ${escapeHtml(cut(out.owner_note, 300))}\n<i>«${escapeHtml(cut(text, 300))}»</i>`))
  }
  return true
}

/** Вопрос Яна о команде. Только чтение: бот ничего не меняет. */
export async function aiOwnerText(user, chatId, text, logged, now = new Date()) {
  if (!aiEnabled() || !text) return false
  const [context, history] = await Promise.all([ownerContext(now), recentHistory(user.id, logged?.id)])
  const prompt = ownerPrompt({ context, history, message: text })
  const out = await askJson({ userId: user.id, kind: 'own', ...prompt, schema: OWNER_SCHEMA }, now)
  if (!out?.reply) return false
  await say(user, chatId, out.reply)
  return true
}

/**
 * Сложность личной задачи по смыслу — для подсказки в «На проверке».
 * Не вышло (нет ключа, лимит) — остаётся оценка по длине описания.
 */
export async function aiRateReview(review) {
  if (!aiEnabled() || !review.taskTitle || !review.complexity) return review.complexity
  const out = await askJson({ userId: review.userId, kind: 'task', ...taskPrompt({ title: review.taskTitle, description: review.taskDescription }), schema: TASK_SCHEMA })
  if (!out?.complexity || out.complexity === review.complexity) return review.complexity
  await prisma.motivationReview.update({ where: { id: review.id }, data: { complexity: out.complexity } }).catch(() => {})
  return out.complexity
}
