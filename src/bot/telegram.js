import { env } from '../config/env.js'

// Адрес API можно подменить: локально бот говорит с поддельным телеграмом
// (src/scripts/fakeTelegram.js), чтобы не трогать боевой токен.
const API = () => `${env.telegramApiBase}${env.telegramBotToken}`

/**
 * Названия звонков и заметки пишут люди, и в них попадаются < > &.
 * Без экранирования телеграм отвергнет сообщение целиком — причём
 * именно в тот раз, когда в тексте оказалась угловая скобка.
 */
export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * Кнопки под сообщением: [[{ text, data }], …] — ряды кнопок. data уходит
 * обратно боту при нажатии (не длиннее 64 байт), url — открывает ссылку.
 */
function keyboard(buttons) {
  if (!buttons?.length) return undefined
  return {
    inline_keyboard: buttons.map((row) => row.map((b) => (b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data }))),
  }
}

async function call(method, body) {
  const res = await fetch(`${API()}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => null)
  return { data, status: res.status }
}

export async function sendMessage(chatId, text, { buttons } = {}) {
  const { data, status } = await call('sendMessage', {
    chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: keyboard(buttons),
  })
  if (!data?.ok) {
    // Не бросаем: одно неотправленное сообщение не повод ронять процесс,
    // в котором заодно крутится вся CRM.
    console.error(`[бот] сообщение в ${chatId} не ушло:`, data?.description || status)
    return { ok: false }
  }
  return { ok: true, messageId: data.result?.message_id }
}

/** Поменять уже отправленное сообщение — например, убрать кнопки после ответа. */
export async function editMessage(chatId, messageId, text, { buttons } = {}) {
  const { data } = await call('editMessageText', {
    chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: keyboard(buttons),
  })
  if (!data?.ok && !/not modified/.test(data?.description || '')) {
    console.error(`[бот] сообщение ${messageId} не изменилось:`, data?.description)
  }
  return { ok: Boolean(data?.ok) }
}

/** Ответ на нажатие кнопки: без него у человека крутятся часики на кнопке. */
export async function answerCallback(callbackId, text) {
  await call('answerCallbackQuery', { callback_query_id: callbackId, text: text || undefined }).catch(() => {})
}

/** Длинный опрос: телеграм держит запрос, пока не появится обновление. */
export async function getUpdates(offset, timeoutSec = 30) {
  const url = `${API()}/getUpdates?timeout=${timeoutSec}&allowed_updates=["message","callback_query"]` +
    (offset ? `&offset=${offset}` : '')
  const res = await fetch(url)
  const data = await res.json().catch(() => null)
  if (!data?.ok) throw new Error(data?.description || `getUpdates: ${res.status}`)
  return data.result
}

export async function whoAmI() {
  const me = await fetch(`${API()}/getMe`).then((r) => r.json()).catch(() => null)
  if (!me?.ok) throw new Error('телеграм не принял токен')
  return me.result.username
}
