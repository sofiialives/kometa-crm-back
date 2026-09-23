import { env } from '../config/env.js'

const API = () => `https://api.telegram.org/bot${env.telegramBotToken}`

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

export async function sendMessage(chatId, text) {
  const res = await fetch(`${API()}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  })

  const data = await res.json().catch(() => null)
  if (!data?.ok) {
    // Не бросаем: одно неотправленное сообщение не повод ронять процесс,
    // в котором заодно крутится вся CRM.
    console.error(`[бот] сообщение в ${chatId} не ушло:`, data?.description || res.status)
    return { ok: false }
  }
  return { ok: true }
}

/** Длинный опрос: телеграм держит запрос, пока не появится обновление. */
export async function getUpdates(offset, timeoutSec = 30) {
  const url = `${API()}/getUpdates?timeout=${timeoutSec}&allowed_updates=["message"]` +
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
