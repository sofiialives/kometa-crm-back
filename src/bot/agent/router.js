import { prisma } from '../../config/prisma.js'
import { isParticipant } from '../../services/motivation/access.js'
import { parseIntent, parseUntil } from '../parse.js'
import { answerCallback, editMessage, escapeHtml } from '../telegram.js'
import { comeBack, decideForceMajeure, MENU, reportForceMajeure, runningLate, setBreakMinutes, startBreak } from './away.js'
import { recordAnswer } from './checkin.js'
import { decideReview } from './feed.js'
import { short } from './format.js'
import { logMessage, tellChat } from './notify.js'
import * as state from './state.js'
import { lateForTask, reportTaskLate, takeTask } from './tasks.js'

/**
 * Что человек пишет и нажимает. Без ИИ — простыми правилами (parse.js):
 * понятное делаем, непонятное — предлагаем кнопками. Когда подключим
 * Claude, он возьмёт на себя то, что сюда не попало.
 */

const STAFF_HELP =
  'Я понимаю простые фразы: «отхожу на 30 минут», «буду в 16:30», «вернулся», ' +
  '«задерживаюсь до 17», «форс-мажор, заболел». Или нажми кнопку:'

const OWNER_HELP =
  'Сюда приходят отчёты: кто отошёл и вернулся, форс-мажоры, внезапные чек-ины ' +
  'и заявки «На проверке». Решения — кнопками прямо под сообщениями.'

async function onIntent(user, intent, text, logged, now) {
  if (intent.type === 'away') return startBreak(user, { until: intent.until, note: text }, now)
  if (intent.type === 'back') return comeBack(user, now)
  if (intent.type === 'late') return runningLate(user, { until: intent.until, text }, now)
  if (intent.type === 'force_majeure') return reportForceMajeure(user, text, logged, now)
  return null
}

/** Ответ на вопрос бота («до скольки?», «что случилось?»). true — разобрали. */
async function onWaiting(user, waiting, text, logged, now) {
  if (waiting.type === 'fm_text') {
    await reportForceMajeure(user, text, logged, now)
    return true
  }
  if (waiting.type === 'task_late') {
    await reportTaskLate(user, waiting.payload.taskId, text)
    return true
  }
  if (waiting.type === 'break_time') {
    const intent = parseIntent(text, now)
    if (intent?.type === 'back') {
      await comeBack(user, now)
      return true
    }
    if (intent?.type === 'force_majeure') return false
    const until = parseUntil(text, now)
    if (until) {
      await startBreak(user, { until }, now)
      return true
    }
    await tellChat(user.chatId, 'Не понял время. Оставляю как есть — поправить можно кнопкой или фразой «до 16:30».', { userId: user.id })
    return true
  }
  return false
}

/** Текстовое сообщение от человека, который подключил телеграм в CRM. */
export async function onText(user, chatId, text, now = new Date()) {
  const me = { ...user, chatId }
  const logged = await logMessage({ userId: user.id, chatId, direction: 'in', text: text || '[не текст]' })
  if (!isParticipant(user)) {
    await tellChat(chatId, OWNER_HELP, { userId: user.id })
    return
  }
  if (!text || /^\/(start|menu|help)\b/.test(text)) {
    await tellChat(chatId, STAFF_HELP, { userId: user.id, buttons: MENU })
    return
  }

  const answered = await recordAnswer(user.id, text, now)
  const waiting = state.take(user.id)
  if (waiting && (await onWaiting(me, waiting, text, logged, now))) return

  const intent = parseIntent(text, now)
  if (intent) {
    await onIntent(user, intent, text, logged, now)
    return
  }
  if (answered) {
    await tellChat(chatId, 'Записал ✍️ Спасибо!', { userId: user.id })
    return
  }
  await tellChat(chatId, STAFF_HELP, { userId: user.id, buttons: MENU })
}

/** Текст нажатой кнопки — для журнала. */
function pressedText(cb) {
  for (const r of cb.message?.reply_markup?.inline_keyboard ?? []) {
    for (const b of r) if (b.callback_data === cb.data) return b.text
  }
  return cb.data
}

/** Убрать кнопки у сообщения и дописать, что выбрали. */
function closeButtons(cb, note) {
  const original = escapeHtml(cb.message?.text || '')
  return editMessage(cb.message.chat.id, cb.message.message_id, note ? `${original}\n\n→ ${note}` : original)
}

/** Нажатие кнопки под сообщением бота. */
export async function onCallback(cb, user, now = new Date()) {
  const chatId = cb.message?.chat?.id
  const data = String(cb.data || '')
  await logMessage({ userId: user.id, chatId, direction: 'in', text: `[кнопка] ${pressedText(cb)}` })
  const [kind, action, id] = data.split(':')
  const owner = user.role === 'admin'

  if (kind === 'rv' || kind === 'fm') {
    if (!owner) return answerCallback(cb.id, 'Это решает владелец')
    if (kind === 'rv') {
      const result = await decideReview(user, data, now)
      await answerCallback(cb.id)
      return editMessage(chatId, cb.message.message_id, result.text, { buttons: result.buttons })
    }
    const result = await decideForceMajeure(user, id, action === 'y', now)
    await answerCallback(cb.id, result.toast)
    if (result.text) await editMessage(chatId, cb.message.message_id, result.text)
    return null
  }
  if (!isParticipant(user)) return answerCallback(cb.id)
  await answerCallback(cb.id)

  if (kind === 'm' && action === 'away') return startBreak(user, {}, now)
  if (kind === 'm' && action === 'back') return comeBack(user, now)
  if (kind === 'm' && action === 'fm') {
    state.expect(user.id, 'fm_text')
    return tellChat(chatId, 'Что случилось и до какого времени? Напиши одной строкой — передам Яну.', { userId: user.id })
  }
  if (kind === 'aw') {
    await closeButtons(cb, `${action} мин`)
    return setBreakMinutes(user, Number(action), now)
  }
  if (kind === 'rt') {
    await closeButtons(cb, action === 'y' ? 'на месте' : 'задерживаюсь')
    return action === 'y' ? comeBack(user, now) : runningLate(user, {}, now)
  }
  if (kind === 'tk') {
    const text = action === 'go' ? await takeTask(user, id) : await lateForTask(user, id)
    return closeButtons(cb, text)
  }
  if (kind === 'ci') {
    const task = await prisma.task.findUnique({ where: { id: action }, select: { title: true, ownerId: true } })
    const ok = task?.ownerId === user.id && (await recordAnswer(user.id, `В работе: ${task.title}`, now))
    return closeButtons(cb, ok ? `записал: «${escapeHtml(short(task.title, 80))}»` : 'чек-ин уже закрыт')
  }
  return null
}
