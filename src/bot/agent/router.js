import { prisma } from '../../config/prisma.js'
import { isParticipant } from '../../services/motivation/access.js'
import { parseIntent, parseUntil } from '../parse.js'
import { answerCallback, editMessage, escapeHtml } from '../telegram.js'
import { BREAK_MINUTES, comeBack, decideForceMajeure, MENU, reportForceMajeure, runningLate, setBreakMinutes, startBreak } from './away.js'
import { isAskedNow, penalizeIfDeferred, recordAnswer } from './checkin.js'
import { decideReview } from './feed.js'
import { points, short } from './format.js'
import { logMessage, sendOnce, tellChat } from './notify.js'
import { mskDayKey, mskDayStart } from '../plan.js'
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

// Сколько сообщений в день человек может написать боту сам. Ответы на
// вопросы бота и кнопки в лимит не идут. И не чаще нескольких в минуту —
// иначе один человек засыпал бы Яна отчётами и занял бы бота для всех.
const DAILY_LIMIT = 20
const PER_MINUTE = 6
const BUTTONS_PER_MINUTE = 20

async function recentCount(userId, directions, since) {
  return prisma.botMessage.count({ where: { userId, direction: { in: directions }, createdAt: { gt: since } } })
}

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
  // Лимиты — по настоящим часам: это защита от потока сообщений.
  const real = new Date()
  if ((await recentCount(user.id, ['in', 'reply'], new Date(real.getTime() - 60000))) >= PER_MINUTE) return

  const isReply = isParticipant(user) && Boolean(state.peek(user.id) || (await isAskedNow(user.id, now)))
  const command = !text || /^\/(start|menu|help)\b/.test(text)
  if (!isReply && !command && isParticipant(user)) {
    const day = mskDayKey(real)
    if ((await recentCount(user.id, ['in'], mskDayStart(day))) >= DAILY_LIMIT) {
      await sendOnce(`limit:${user.id}:${day}`, () => tellChat(chatId,
        `На сегодня я принял уже ${DAILY_LIMIT} сообщений. Отлучку, возвращение и форс-мажор можно отметить кнопками — они работают без лимита.`,
        { userId: user.id, buttons: MENU }))
      return
    }
  }
  const logged = await logMessage({ userId: user.id, chatId, direction: isReply ? 'reply' : 'in', text: text || '[не текст]' })
  if (!isParticipant(user)) {
    await tellChat(chatId, OWNER_HELP, { userId: user.id })
    return
  }
  if (command) {
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
  const data = String(cb.data || '').slice(0, 64)
  if ((await recentCount(user.id, ['button'], new Date(Date.now() - 60000))) >= BUTTONS_PER_MINUTE) return answerCallback(cb.id)
  await logMessage({ userId: user.id, chatId, direction: 'button', text: pressedText(cb) })
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
    let text = result.text
    if (result.rejectedUserId) {
      // Из-за заявки человека не оштрафовали на чек-ине — теперь штраф ложится.
      const penalty = await penalizeIfDeferred(result.rejectedUserId, now)
      if (penalty !== null) text += `\n\nЧек-ин: ${points(penalty)} — штраф ждал вашего решения.`
    }
    if (text) await editMessage(chatId, cb.message.message_id, text)
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
    const minutes = Number(action)
    if (!BREAK_MINUTES.includes(minutes)) return null
    await closeButtons(cb, `${minutes} мин`)
    return setBreakMinutes(user, minutes, now)
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
