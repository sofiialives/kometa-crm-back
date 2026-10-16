import http from 'node:http'
import { readFileSync, statSync } from 'node:fs'

/**
 * Поддельный телеграм для проверки бота локально — без боевого токена и
 * без настоящих людей. Отвечает на те методы, которыми пользуется бот, и
 * запоминает всё, что бот «отправил».
 *
 *   node src/scripts/fakeTelegram.js            # слушает 4900
 *   TELEGRAM_API_BASE=http://localhost:4900/bot TELEGRAM_BOT_TOKEN=fake npm run dev
 *
 * Управление (имитация людей):
 *   POST /_say    { chatId, text }               — человек написал боту
 *   POST /_photo  { chatId, caption, path, group } — прислал фото с диска
 *                                                  (group — часть альбома)
 *   POST /_press  { chatId, messageId, data }    — нажал кнопку под сообщением
 *   GET  /_log                                   — что бот отправил и изменил
 *   POST /_reset                                 — очистить
 */

const PORT = Number(process.env.FAKE_TELEGRAM_PORT) || 4900

let updateId = 1
let messageId = 1
let updates = []
let waiters = []
let log = []
const messages = new Map()
// Файлы, которые «прислали» люди: fileId → путь на диске.
const files = new Map()
let fileNo = 1

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function push(update) {
  updates.push({ update_id: updateId++, ...update })
  for (const w of waiters) w()
  waiters = []
}

async function rawBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  return Buffer.concat(chunks)
}

async function body(req) {
  const raw = (await rawBody(req)).toString()
  try {
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

/** Поля multipart-формы без файла и имя файла: проверке этого хватает. */
function formFields(buffer, type) {
  const boundary = /boundary=([^;]+)/.exec(type)?.[1]
  const fields = {}
  if (!boundary) return fields
  for (const part of buffer.toString('latin1').split(`--${boundary}`)) {
    const name = /name="([^"]+)"/.exec(part)?.[1]
    if (!name) continue
    const file = /filename="([^"]*)"/.exec(part)?.[1]
    const value = part.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n$/, '')
    fields[name] = file !== undefined ? { fileName: Buffer.from(file, 'latin1').toString('utf8'), size: Buffer.byteLength(value, 'latin1') } : Buffer.from(value, 'latin1').toString('utf8')
  }
  return fields
}

const chat = (chatId) => ({ id: Number(chatId), type: 'private' })

// Только запросы своей машины: страница в браузере не должна достучаться
// до управляющих адресов (DNS rebinding) и подсунуть свой путь к файлу.
const HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`])
const FIXTURE = /\.(jpe?g|png|webp|gif|pdf)$/i

const server = http.createServer((req, res) => handle(req, res).catch((e) => json(res, 500, { ok: false, description: e.message })))

async function handle(req, res) {
  if (!HOSTS.has(String(req.headers.host))) return json(res, 403, { ok: false, description: 'host' })
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const path = url.pathname
  if (path.startsWith('/_') && path !== '/_reset' && req.method === 'POST' && !String(req.headers['content-type'] || '').startsWith('application/json')) {
    return json(res, 415, { ok: false, description: 'json only' })
  }

  if (path === '/_say') {
    const { chatId, text } = await body(req)
    push({ message: { message_id: messageId++, chat: chat(chatId), from: { id: Number(chatId) }, text, date: Math.floor(Date.now() / 1000) } })
    return json(res, 200, { ok: true })
  }
  if (path === '/_photo') {
    const { chatId, caption, path: file, group } = await body(req)
    // Только картинки и PDF для проверок, а не любой файл с диска.
    if (!FIXTURE.test(String(file))) return json(res, 400, { ok: false, description: 'только jpg, png, webp, gif, pdf' })
    const id = `file${fileNo++}`
    files.set(id, file)
    const size = statSync(file).size
    push({ message: {
      message_id: messageId++, chat: chat(chatId), from: { id: Number(chatId) }, date: Math.floor(Date.now() / 1000),
      photo: [{ file_id: `${id}s`, width: 90, height: 60, file_size: 1000 }, { file_id: id, width: 1280, height: 960, file_size: size }],
      ...(caption ? { caption } : {}),
      ...(group ? { media_group_id: String(group) } : {}),
    } })
    files.set(`${id}s`, file)
    return json(res, 200, { ok: true, fileId: id })
  }
  if (path.startsWith('/file/')) {
    // Скачивание файла: /file/bot<токен>/<путь> — путь у нас это fileId.
    const id = path.split('/').pop()
    if (!files.has(id)) return json(res, 404, { ok: false })
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
    return res.end(readFileSync(files.get(id)))
  }
  if (path === '/_press') {
    const { chatId, messageId: id, data } = await body(req)
    const m = messages.get(Number(id))
    push({ callback_query: { id: `cb${updateId}`, from: { id: Number(chatId) }, data, message: { message_id: Number(id), chat: chat(chatId), text: m?.text ?? '', reply_markup: m?.reply_markup } } })
    return json(res, 200, { ok: true })
  }
  if (path === '/_log') return json(res, 200, log)
  if (path === '/_reset') {
    updates = []
    log = []
    messages.clear()
    files.clear()
    return json(res, 200, { ok: true })
  }

  const method = path.split('/').pop()
  const type = String(req.headers['content-type'] || '')
  const params = req.method !== 'POST'
    ? Object.fromEntries(url.searchParams)
    : type.startsWith('multipart/') ? formFields(await rawBody(req), type) : await body(req)
  if (method === 'getMe') return json(res, 200, { ok: true, result: { id: 1, is_bot: true, username: 'kometa_test_bot' } })
  if (method === 'getUpdates') {
    const offset = Number(params.offset) || 0
    const ready = () => updates.filter((u) => u.update_id >= offset)
    if (!ready().length) await new Promise((r) => { waiters.push(r); setTimeout(r, 1000) })
    updates = updates.filter((u) => u.update_id >= offset)
    return json(res, 200, { ok: true, result: ready() })
  }
  if (method === 'sendMessage') {
    // Чаты с номером от 9990000 — «бот заблокирован»: проверка недоставки.
    if (Number(params.chat_id) >= 9990000) return json(res, 403, { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' })
    const id = messageId++
    // Как настоящий телеграм: HTML должен быть корректным, иначе отказ.
    const stripped = String(params.text).replace(/<\/?(b|i|u|s|code|pre|a)( [^>]*)?>/g, '')
    if (/[<>]/.test(stripped)) return json(res, 400, { ok: false, description: "Bad Request: can't parse entities" })
    const text = String(params.text).replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    messages.set(id, { text, reply_markup: params.reply_markup })
    log.push({ type: 'send', chatId: String(params.chat_id), messageId: id, text, html: params.text, buttons: params.reply_markup?.inline_keyboard ?? null })
    return json(res, 200, { ok: true, result: { message_id: id } })
  }
  if (method === 'editMessageText') {
    const text = String(params.text).replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    messages.set(Number(params.message_id), { text, reply_markup: params.reply_markup })
    log.push({ type: 'edit', chatId: String(params.chat_id), messageId: Number(params.message_id), text, buttons: params.reply_markup?.inline_keyboard ?? null })
    return json(res, 200, { ok: true, result: true })
  }
  if (method === 'getFile') {
    if (!files.has(params.file_id)) return json(res, 400, { ok: false, description: 'Bad Request: invalid file_id' })
    return json(res, 200, { ok: true, result: { file_id: params.file_id, file_path: params.file_id, file_size: statSync(files.get(params.file_id)).size } })
  }
  if (method === 'sendChatAction') return json(res, 200, { ok: true, result: true })
  if (['sendPhoto', 'sendVideo', 'sendDocument', 'sendVoice', 'sendAudio', 'sendAnimation', 'sendVideoNote'].includes(method)) {
    const id = messageId++
    const file = params.document?.fileName ? { upload: params.document.fileName, size: params.document.size } : { fileId: params.photo ?? params.video ?? params.document ?? params.voice ?? params.audio ?? params.animation ?? params.video_note }
    log.push({ type: 'file', method, chatId: String(params.chat_id), messageId: id, caption: params.caption ?? null, ...file })
    return json(res, 200, { ok: true, result: { message_id: id, document: { file_id: `up${id}` } } })
  }
  if (method === 'sendMediaGroup') {
    const media = Array.isArray(params.media) ? params.media : []
    log.push({ type: 'album', chatId: String(params.chat_id), count: media.length, caption: media[0]?.caption ?? null, files: media.map((m) => m.media) })
    return json(res, 200, { ok: true, result: media.map(() => ({ message_id: messageId++ })) })
  }
  if (method === 'answerCallbackQuery') {
    log.push({ type: 'toast', id: params.callback_query_id, text: params.text ?? null })
    return json(res, 200, { ok: true, result: true })
  }
  return json(res, 404, { ok: false, description: `Not Found: ${method}` })
}

// Только своя машина: управляющие адреса (/_say, /_press) без пароля.
server.listen(PORT, '127.0.0.1', () => console.log(`[поддельный телеграм] http://localhost:${PORT}`))
