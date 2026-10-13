import http from 'node:http'

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

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function push(update) {
  updates.push({ update_id: updateId++, ...update })
  for (const w of waiters) w()
  waiters = []
}

async function body(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString()
  try {
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

const chat = (chatId) => ({ id: Number(chatId), type: 'private' })

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const path = url.pathname

  if (path === '/_say') {
    const { chatId, text } = await body(req)
    push({ message: { message_id: messageId++, chat: chat(chatId), from: { id: Number(chatId) }, text, date: Math.floor(Date.now() / 1000) } })
    return json(res, 200, { ok: true })
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
    return json(res, 200, { ok: true })
  }

  const method = path.split('/').pop()
  const params = req.method === 'POST' ? await body(req) : Object.fromEntries(url.searchParams)
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
  if (method === 'answerCallbackQuery') {
    log.push({ type: 'toast', id: params.callback_query_id, text: params.text ?? null })
    return json(res, 200, { ok: true, result: true })
  }
  return json(res, 404, { ok: false, description: `Not Found: ${method}` })
})

// Только своя машина: управляющие адреса (/_say, /_press) без пароля.
server.listen(PORT, '127.0.0.1', () => console.log(`[поддельный телеграм] http://localhost:${PORT}`))
