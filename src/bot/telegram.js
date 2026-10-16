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
      // Часть длинного уже ушла — не повторяем, иначе начало придёт дважды.
      if (i > 0) return { ok: true, messageId, partial: true }
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

/** «Печатает…» в чате, пока агент думает. Гаснет само через 5 секунд. */
export async function sendChatAction(chatId, action = 'typing') {
  await call('sendChatAction', { chat_id: chatId, action }, { timeoutMs: 5000 }).catch(() => {})
}

// Адрес файлов телеграма: тот же сервер, только /file/bot<токен>/путь.
const FILE_API = () => `${String(env.telegramApiBase).replace(/\/bot$/, '/file/bot')}${env.telegramBotToken}`

/**
 * Скачать файл, который прислал человек. Телеграм отдаёт ботам файлы до
 * 20 МБ; больше maxBytes не качаем — ни памяти, ни токенов на это не
 * тратим. null — не вышло или слишком большой.
 */
export async function downloadFile(fileId, { maxBytes = 5 * 1024 * 1024 } = {}) {
  const { data } = await call('getFile', { file_id: fileId })
  const path = data?.ok ? data.result?.file_path : null
  // Путь отдаёт сам телеграм, но в адрес подставляем только обычный путь.
  if (!path || !/^[\w\-./]+$/.test(path) || path.includes('..') || (data.result.file_size ?? 0) > maxBytes) return null
  try {
    const res = await fetch(`${FILE_API()}/${path}`, { signal: AbortSignal.timeout(20000) })
    if (!res.ok || Number(res.headers.get('content-length') ?? 0) > maxBytes) return null
    // Читаем по кускам и бросаем, как только больше maxBytes: размер от
    // телеграма может не прийти.
    const chunks = []
    let size = 0
    for await (const chunk of res.body) {
      size += chunk.length
      if (size > maxBytes) return null
      chunks.push(chunk)
    }
    return { buffer: Buffer.concat(chunks), path }
  } catch {
    return null
  }
}

const SEND_BY_KIND = {
  photo: ['sendPhoto', 'photo'],
  video: ['sendVideo', 'video'],
  animation: ['sendAnimation', 'animation'],
  voice: ['sendVoice', 'voice'],
  audio: ['sendAudio', 'audio'],
  video_note: ['sendVideoNote', 'video_note'],
  document: ['sendDocument', 'document'],
}

/**
 * Переслать файл, который уже есть в телеграме, по его fileId: фото, видео,
 * документ. Подпись — HTML, до 1024 символов (у кружка подписи не бывает).
 */
export async function sendFileById(chatId, kind, fileId, { caption } = {}) {
  const [method, field] = SEND_BY_KIND[kind] ?? SEND_BY_KIND.document
  const body = { chat_id: chatId, [field]: fileId }
  if (caption && kind !== 'video_note') Object.assign(body, { caption: String(caption).slice(0, 1024), parse_mode: 'HTML' })
  const { data, status } = await call(method, body, { timeoutMs: 30000 })
  if (!data?.ok) console.error(`[бот] файл в ${chatId} не ушёл:`, data?.description || status)
  return { ok: Boolean(data?.ok), retry: !data?.ok && (status === 0 || status === 429 || status >= 500) }
}

/**
 * Альбом из фото и видео, до 10 штук. Подпись — у первого: так телеграм
 * показывает её под всем альбомом.
 */
export async function sendAlbum(chatId, items, { caption } = {}) {
  const media = items.slice(0, 10).map((it, i) => ({
    type: it.kind === 'video' ? 'video' : 'photo',
    media: it.fileId,
    ...(i === 0 && caption ? { caption: String(caption).slice(0, 1024), parse_mode: 'HTML' } : {}),
  }))
  if (media.length === 1) return sendFileById(chatId, media[0].type, media[0].media, { caption })
  const { data, status } = await call('sendMediaGroup', { chat_id: chatId, media }, { timeoutMs: 30000 })
  if (!data?.ok) console.error(`[бот] альбом в ${chatId} не ушёл:`, data?.description || status)
  return { ok: Boolean(data?.ok), retry: !data?.ok && (status === 0 || status === 429 || status >= 500) }
}

/** Отправить готовый файл: таблицу или документ, который собрал агент. */
export async function uploadDocument(chatId, buffer, fileName, { caption, mime = 'application/octet-stream' } = {}) {
  const form = new FormData()
  form.append('chat_id', String(chatId))
  if (caption) {
    form.append('caption', String(caption).slice(0, 1024))
    form.append('parse_mode', 'HTML')
  }
  form.append('document', new Blob([buffer], { type: mime }), fileName)
  try {
    const res = await fetch(`${API()}/sendDocument`, { method: 'POST', body: form, signal: AbortSignal.timeout(60000) })
    const data = await res.json().catch(() => null)
    if (!data?.ok) console.error(`[бот] файл ${fileName} не ушёл:`, data?.description || res.status)
    return { ok: Boolean(data?.ok), fileId: data?.result?.document?.file_id ?? null }
  } catch (e) {
    console.error(`[бот] файл ${fileName} не ушёл:`, e.name)
    return { ok: false, fileId: null }
  }
}
