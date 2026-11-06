import { prisma } from '../../config/prisma.js'
import { patch } from './patch.js'

/**
 * Общая подмена для проверок бота без базы и телеграма: отметки
 * BotNotice в памяти, чат у любого человека, телеграм принимает всё и
 * складывает отправленное в sent ({ chatId, text, buttons }), журнал
 * BotMessage — в logged.
 */
export function botHarness(t) {
  const notices = new Set()
  const sent = []
  const logged = []
  const edits = []
  patch(t, prisma.botNotice, 'findUnique', async ({ where }) => (notices.has(where.key) ? { key: where.key } : null))
  patch(t, prisma.botNotice, 'create', async ({ data }) => {
    if (notices.has(data.key)) throw Object.assign(new Error('dup'), { code: 'P2002' })
    notices.add(data.key)
    return data
  })
  patch(t, prisma.botNotice, 'delete', async ({ where }) => { notices.delete(where.key); return {} })
  patch(t, prisma.telegramLink, 'findFirst', async ({ where }) => ({ chatId: `chat-${where.userId}` }))
  patch(t, prisma.botMessage, 'create', async ({ data }) => { logged.push(data); return { id: `m${logged.length}` } })
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const method = String(url).split('/').pop()
    const body = init?.body ? JSON.parse(init.body) : {}
    if (method === 'editMessageText') edits.push({ text: body.text, buttons: body.reply_markup?.inline_keyboard })
    if (method === 'sendMessage') sent.push({ chatId: body.chat_id, text: body.text, buttons: body.reply_markup?.inline_keyboard })
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }))
  }
  t.after(() => { globalThis.fetch = realFetch })
  return { notices, sent, logged, edits }
}
