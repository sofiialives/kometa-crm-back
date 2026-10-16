import { prisma } from '../../config/prisma.js'
import { isParticipant } from '../../services/motivation/access.js'
import { isBareTime, parseIntent, parseRemindAt, parseUntil, teamRequest } from '../parse.js'
import { answerCallback, editMessage, escapeHtml } from '../telegram.js'
import { BREAK_MINUTES, comeBack, dayEnd, decideForceMajeure, hasOpenBreak, MENU, reportForceMajeure, runningLate, setBreakMinutes, startBreak } from './away.js'
import { isAskedNow, penalizeIfDeferred, recordAnswer } from './checkin.js'
import { decideReview } from './feed.js'
import { points, short } from './format.js'
import { logMessage, sendOnce, tellChat } from './notify.js'
import { mskDayKey, mskDayStart } from '../plan.js'
import * as state from './state.js'
import { lateForTask, reportTaskLate, takeTask } from './tasks.js'
import { askReminderTime, cancelReminder, createReminder, REMIND_MINUTES, tooFarReminder } from './remind.js'
import { agentReply } from '../ai/agent.js'
import { activeTarget, decideDraft, decideReport } from './rounds.js'
import { listIntent, listText } from './lists.js'

/**
 * Что человек пишет и нажимает. Без ИИ — простыми правилами (parse.js):
 * понятное делаем, непонятное — предлагаем кнопками. Когда подключим
 * Claude, он возьмёт на себя то, что сюда не попало.
 */

const PHRASES =
  'Я понимаю такие фразы\n' +
  '• <i>отхожу на 30 минут</i>\n' +
  '• <i>буду в 16:30</i>\n' +
  '• <i>вернулся</i>\n' +
  '• <i>задерживаюсь до 17</i>\n' +
  '• <i>заболел, форс-мажор</i>\n' +
  '• <i>напомни в 15:00 позвонить клиенту</i>\n\n' +
  'Или нажми кнопку ниже'
const STAFF_MENU = `Я на связи.\n\n${PHRASES}`
// Не понял — коротко, без всего списка: несколько непонятых подряд не
// должны превращаться в простыню. Полный список — в /menu.
const STAFF_HELP =
  'Не понял тебя.\n' +
  'Напиши, например, <i>отхожу на 30 минут</i>, или нажми кнопку ниже.\n\n' +
  'Все фразы, которые я понимаю, есть в /menu'
// Вопрос без ИИ (нет ключа, кончился лимит) — честно, что пока не отвечаю.
const STAFF_QUESTION =
  'На такие вопросы я пока не отвечаю.\n' +
  'Могу отметить отлучку, задержку или форс-мажор, кнопки ниже.\n\n' +
  'Все фразы, которые я понимаю, есть в /menu'

// Сколько сообщений в день человек может написать боту сам. Ответы на
// вопросы бота и кнопки в лимит не идут. И не чаще нескольких в минуту —
// иначе один человек засыпал бы Яна отчётами и занял бы бота для всех.
// Потолок от спама на все сообщения за день. Вопросы к ИИ ограничены
// отдельно (AI_LIMITS), команды по правилам ничего не стоят.
const DAILY_LIMIT = 200
const LIMIT_TEXT =
  'Лимит сообщений на сегодня закончился.\nОн обновится в 00:00 по Москве.\n\n' +
  'Кнопки «Отхожу», «Я на месте» и «Форс-мажор» работают без лимита.'
const PER_MINUTE = 10
const BUTTONS_PER_MINUTE = 20

async function recentCount(userId, directions, since) {
  return prisma.botMessage.count({ where: { userId, direction: { in: directions }, createdAt: { gt: since } } })
}

const OWNER_HELP =
  'Сюда приходят отчёты по команде\n' +
  '• кто отходит и возвращается\n' +
  '• форс-мажоры\n' +
  '• внезапные чек-ины\n' +
  '• заявки на баллы\n\n' +
  'Решения принимаются кнопками под сообщениями.'

async function onIntent(user, intent, text, logged, now) {
  if (intent.type === 'away') return startBreak(user, { until: intent.until, note: text }, now)
  if (intent.type === 'day_end') return dayEnd(user, now)
  if (intent.type === 'back') return comeBack(user, now)
  if (intent.type === 'late') return runningLate(user, { until: intent.until, text }, now)
  if (intent.type === 'force_majeure') return reportForceMajeure(user, text, logged, now)
  if (intent.type === 'remind') {
    if (intent.until) return createReminder(user, intent.until, text, now)
    if (intent.far) return tooFarReminder(user)
    return askReminderTime(user, text, { tomorrow: intent.tomorrow })
  }
  return null
}

/** Ответ на вопрос бота («до скольки?», «что случилось?»). true — разобрали. */
async function onWaiting(user, waiting, text, logged, now) {
  if (waiting.type === 'fm_text') {
    await reportForceMajeure(user, text, logged, now)
    return true
  }
  if (waiting.type === 'remind_time') {
    // «Заболел, до 18:00 не выйду» — это заявка на форс-мажор, а не время напоминания.
    const intent = parseIntent(text, now)
    if (intent && intent.type !== 'remind') return false
    const { until } = parseRemindAt(text, now, { tomorrow: Boolean(waiting.payload.tomorrow) })
    if (!until) return false
    await createReminder(user, until, waiting.payload.text, now)
    return true
  }
  if (waiting.type === 'task_late') {
    await reportTaskLate(user, waiting.payload.taskId, text, now)
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
      await startBreak(user, { until, extend: Boolean(waiting.payload.extend) }, now)
      return true
    }
    // Правила время не нашли («минут через сорок», «к концу обеда») — ИИ.
    if (await agentReply({ user, chatId: user.chatId, text, logged, kind: 'reply', extend: Boolean(waiting.payload.extend) }, now)) return true
    await tellChat(user.chatId, 'Не понял время, оставляю как было.\nПоправить можно кнопкой или написать, например, <i>до 16:30</i>', { userId: user.id })
    return true
  }
  return false
}

/**
 * Сообщение от человека, который подключил телеграм в CRM. media — что
 * прислали вместо текста («голосовое», «фото»…): на чек-ин это тоже ответ.
 * files — сами файлы ({ fileId, kind, mime }), у альбома их несколько.
 */
export async function onText(user, chatId, text, now = new Date(), { media = null, files = [] } = {}) {
  const me = { ...user, chatId }
  // Ответ на чек-ин принимаем первым — даже голосовым и даже в потоке
  // сообщений: иначе человека оштрафовали бы за то, что он ответил.
  const answerText = text || (media ? `[${media}]` : '')
  // Команды (/menu, /start) — не ответ на чек-ин.
  const isCommandText = /^\/\w+/.test(text)
  const answered = isParticipant(user) && answerText && !isCommandText ? await recordAnswer(user.id, answerText, now) : false

  // Лимиты — по настоящим часам: это защита от потока сообщений.
  const real = new Date()
  if ((await recentCount(user.id, ['in', 'reply'], new Date(real.getTime() - 60000))) >= PER_MINUTE) {
    // Не молча: человек должен знать, что сообщение не принято. Раз в минуту.
    const bucket = Math.floor(real.getTime() / 60000)
    await sendOnce(`flood:${user.id}:${bucket}`, () => tellChat(chatId, 'Слишком много сообщений подряд.\nПодожди минуту и напиши ещё раз.', { userId: user.id }))
    return
  }

  const isReply = answered || (isParticipant(user) && Boolean(state.peek(user.id) || (await isAskedNow(user.id, now))))
  // Фото без подписи — не команда: его смотрит агент.
  const command = (!text && !files.length) || /^\/(start|menu|help)\b/.test(text)
  if (!isReply && !command && isParticipant(user)) {
    const day = mskDayKey(real)
    if ((await recentCount(user.id, ['in'], mskDayStart(day))) >= DAILY_LIMIT) {
      // Не молча, иначе человек решит, что бот сломался. Раз в час: это спам.
      const hour = Math.floor(real.getTime() / 3600000)
      await sendOnce(`limit:${user.id}:${day}:${hour}`, () => tellChat(chatId, LIMIT_TEXT, { userId: user.id, buttons: MENU }))
      return
    }
  }
  const [first, ...more] = files
  const logged = await logMessage({
    userId: user.id, chatId, direction: isReply ? 'reply' : 'in', text: answerText || '[не текст]',
    fileId: first?.fileId, fileKind: first?.kind, fileMime: first?.mime,
  })
  // Остальные фото альбома — отдельными записями: каждое уйдёт в отчёт.
  const extra = []
  for (const f of more) extra.push(await logMessage({ userId: user.id, chatId, direction: 'file', text: `[${media || 'файл'}]`, fileId: f.fileId, fileKind: f.kind, fileMime: f.mime }))
  const loggedIds = [logged, ...extra].filter(Boolean).map((m) => m.id)
  const ask = (opts = {}) => agentReply({ user: me, chatId, text, logged, loggedIds, files, ...opts }, now)

  if (!isParticipant(user)) {
    // Ян спрашивает о команде и поручает — отвечает агент.
    if (!command && !isCommandText && (await ask())) return
    await tellChat(chatId, OWNER_HELP, { userId: user.id })
    return
  }
  // Идёт разговор по поручению: в отчёт уйдёт то, что дойдёт до агента, а
  // команды по правилам («отошёл на обед») — нет.
  const target = await activeTarget(user.id, now)
  const thanks = () => tellChat(chatId, 'Записал, спасибо.', { userId: user.id })
  if (command) {
    if (answered) return thanks()
    await tellChat(chatId, STAFF_MENU, { userId: user.id, buttons: MENU })
    return
  }

  const waiting = text ? state.take(user.id) : null
  if (waiting && (await onWaiting(me, waiting, text, logged, now))) return

  // Руководитель поручает или спрашивает о своих людях — сразу агенту:
  // «задерживаюсь, спроси отдел, как дела» не должно стать «задержкой».
  if (user.role === 'lead' && teamRequest(text) && !isCommandText && (await ask())) return

  const intent = parseIntent(text, now)
  // «Я в работе над отчётом» на чек-ин — это ответ, а не «вернулся».
  if (intent && !(answered && intent.type === 'back' && !(await hasOpenBreak(user.id, now)))) {
    await onIntent(user, intent, text, logged, now)
    return
  }
  if (answered) return thanks()
  // «До 16:30» без других слов — уточнение текущей или только что
  // закончившейся отлучки. «Встреча в 15:00» — не про отлучку.
  const until = isBareTime(text) ? parseUntil(text, now) : null
  if (until && (await hasOpenBreak(user.id, now, { recentMin: 30 }))) {
    await startBreak(user, { until, extend: true }, now)
    return
  }
  // «Что у меня на сегодня», «мои задачи», «что по звонкам» — список из CRM
  // столбиком, без ИИ: бесплатно и не превращается в сплошной абзац.
  // В разговоре по поручению «мои задачи на сегодня такие» — ответ, а не просьба о списке.
  const list = target ? null : listIntent(text)
  if (list) {
    await tellChat(chatId, await listText(list, user.id, now), { userId: user.id })
    return
  }
  // Правила не поняли — агент. Нет ключа, лимит, сбой — подсказка, как раньше.
  // Незнакомые команды (/что-то) на ИИ не тратим.
  if (!isCommandText && (await ask())) return
  if (!text && files.length) {
    await tellChat(chatId, 'Файл получил, но открыть его сейчас не могу.', { userId: user.id })
    return
  }
  await tellChat(chatId, text.includes('?') ? STAFF_QUESTION : STAFF_HELP, { userId: user.id, buttons: MENU })
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
  return editMessage(cb.message.chat.id, cb.message.message_id, note ? `${original}\n\n<i>${note}</i>` : original)
}

/** Нажатие кнопки под сообщением бота. */
export async function onCallback(cb, user, now = new Date()) {
  const chatId = cb.message?.chat?.id
  const data = String(cb.data || '').slice(0, 64)
  if ((await recentCount(user.id, ['button'], new Date(Date.now() - 60000))) >= BUTTONS_PER_MINUTE) return answerCallback(cb.id)
  await logMessage({ userId: user.id, chatId, direction: 'button', text: pressedText(cb) })
  const [kind, action, id] = data.split(':')
  const owner = user.role === 'admin'

  if (kind === 'rd') {
    // Поручение: черновик и «отчёт сейчас» решает тот, кто поручил.
    await answerCallback(cb.id)
    const note = action === 'go' || action === 'no'
      ? await decideDraft(user, id, action === 'go', now)
      : await decideReport(user, id, action === 'rp', now)
    return closeButtons(cb, note)
  }
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
      if (penalty !== null) text += `\n\nЗа чек-ин ${points(penalty)}, штраф ждал вашего решения.`
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
    return tellChat(chatId, 'Что случилось и до какого времени?\nНапиши одной строкой, я передам Яну.', { userId: user.id })
  }
  if (kind === 'rm') {
    const ok = await cancelReminder(user, id, now)
    return closeButtons(cb, ok ? 'Отменено' : 'Уже не актуально')
  }
  if (kind === 'rmt') {
    const minutes = Number(action)
    // Старая кнопка не должна съесть другое ожидание («что случилось?»).
    const waiting = state.peek(user.id)
    if (!REMIND_MINUTES.includes(minutes) || waiting?.type !== 'remind_time') return closeButtons(cb, 'Напиши ещё раз, о чём напомнить')
    state.take(user.id)
    await closeButtons(cb, `Через ${minutes} мин`)
    return createReminder(user, new Date(now.getTime() + minutes * 60000), waiting.payload.text, now)
  }
  if (kind === 'ai') {
    // Подтверждение того, что понял ИИ: конец дня и заявка на форс-мажор.
    if (cb.message?.date && Date.now() / 1000 - cb.message.date > 3 * 60 * 60) return closeButtons(cb, 'Кнопка устарела')
    if (action === 'de') {
      await closeButtons(cb, 'Да')
      return dayEnd(user, now)
    }
    if (action === 'fm') {
      const message = await prisma.botMessage.findUnique({ where: { id } })
      if (!message || message.userId !== user.id || !['in', 'reply'].includes(message.direction)) return closeButtons(cb, 'Не нашёл сообщение')
      await closeButtons(cb, 'Да')
      return reportForceMajeure(user, message.text, message, now)
    }
    return closeButtons(cb, 'Хорошо, ничего не делаю')
  }
  if (kind === 'aw' || kind === 'ax') {
    // Кнопка со вчерашнего сообщения — не повод ставить отлучку сегодня.
    if (cb.message?.date && Date.now() / 1000 - cb.message.date > 3 * 60 * 60) {
      await closeButtons(cb, 'Кнопка устарела, напиши, например, отхожу на 30 минут')
      return null
    }
    const minutes = Number(action)
    if (!BREAK_MINUTES.includes(minutes)) return null
    await closeButtons(cb, `${minutes} мин`)
    return setBreakMinutes(user, minutes, now, { extend: kind === 'ax' })
  }
  if (kind === 'rt') {
    await closeButtons(cb, action === 'y' ? 'На месте' : 'Задерживаюсь')
    return action === 'y' ? comeBack(user, now) : runningLate(user, {}, now)
  }
  if (kind === 'tk') {
    const text = action === 'go' ? await takeTask(user, id) : await lateForTask(user, id)
    return closeButtons(cb, text)
  }
  if (kind === 'ci') {
    const task = await prisma.task.findUnique({ where: { id: action }, select: { title: true, ownerId: true } })
    if (task?.ownerId !== user.id) return null
    if (await recordAnswer(user.id, `В работе: ${task.title}`, now)) return closeButtons(cb, `Записал, что ты в работе над «${escapeHtml(short(task.title, 80))}»`)
    // Второе нажатие той же кнопки — ответ уже есть, не пугаем «закрыт».
    return (await isAskedNow(user.id, now)) ? null : closeButtons(cb, 'Ответ уже записан или чек-ин закрыт')
  }
  return null
}
