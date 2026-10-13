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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Запрос к API. Сеть упала или телеграм завис — не бросаем, а отвечаем
 * { data: null }: сообщение не ушло, процесс CRM живёт дальше. Телеграм
 * попросил подождать (429) — ждём, сколько сказал, и пробуем ещё раз.
 */
async function call(method, body, { timeoutMs = 15000 } = {}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await fetch(`${API()}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
      const data = await res.json().catch(() => null)
      const wait = data?.parameters?.retry_after
      if (res.status === 429 && attempt === 0 && wait && wait <= 10) {
        await sleep(wait * 1000)
        continue
      }
      return { data, status: res.status }
    } catch (e) {
      return { data: null, status: 0, error: e.message }
    }
  }
  return { data: null, status: 429 }
}

// Телеграм берёт до 4096 символов. Длинное (отчёт чек-ина на всю команду)
// режем по строкам; кнопки — под последним куском.
const MAX_TEXT = 4000

export function splitText(text, max = MAX_TEXT) {
  if (text.length <= max) return [text]
  const parts = []
  let current = ''
  for (const line of text.split('\n')) {
    const piece = line.length > max ? line.slice(0, max - 1) + '…' : line
    if (current && current.length + 1 + piece.length > max) {
      parts.push(current)
      current = piece
    } else {
      current = current ? `${current}\n${piece}` : piece
    }
  }
  if (current) parts.push(current)
  return parts
}

/**
 * Отправить сообщение. { ok, messageId } или { ok: false, retry } — retry
 * значит «сбой временный, можно попробовать позже» (сеть, 429, 5xx). Бот
 * заблокирован или чат не найден — не временно, повторять незачем.
 */
export async function sendMessage(chatId, text, { buttons } = {}) {
  const parts = splitText(String(text))
  let messageId
  for (let i = 0; i < parts.length; i += 1) {
    const last = i === parts.length - 1
    const { data, status } = await call('sendMessage', {
      chat_id: chatId, text: parts[i], parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: last ? keyboard(buttons) : undefined,
    })
    if (!data?.ok) {
      // Не бросаем: одно неотправленное сообщение не повод ронять процесс,
      // в котором заодно крутится вся CRM.
      console.error(`[бот] сообщение в ${chatId} не ушло:`, data?.description || status)
      return { ok: false, retry: status === 0 || status === 429 || status >= 500 }
    }
    messageId = data.result?.message_id
  }
  return { ok: true, messageId }
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
  // Телеграм держит запрос timeoutSec секунд; дольше — соединение зависло.
  const res = await fetch(url, { signal: AbortSignal.timeout((timeoutSec + 15) * 1000) })
  const data = await res.json().catch(() => null)
  if (!data?.ok) throw new Error(data?.description || `getUpdates: ${res.status}`)
  return data.result
}

export async function whoAmI() {
  const me = await fetch(`${API()}/getMe`, { signal: AbortSignal.timeout(15000) }).then((r) => r.json()).catch(() => null)
  if (!me?.ok) throw new Error('телеграм не принял токен')
  return me.result.username
}
