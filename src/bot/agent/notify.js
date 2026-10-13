import { prisma } from '../../config/prisma.js'
import { env } from '../../config/env.js'
import { escapeHtml, sendMessage } from '../telegram.js'

/**
 * Отправка от агента. Всё, что бот пишет и что пишут ему, ложится в
 * BotMessage: по каждому человеку видно, о чём с ним говорили, — это и
 * есть журнал, о котором просил Ян, и память для будущего ИИ.
 */

export const firstName = (full) => String(full || '').trim().split(/\s+/)[0] || 'коллега'
export const nameOf = (user) => escapeHtml(user?.name || 'Сотрудник')

/** Убрать теги для журнала: там нужен читаемый текст, а не разметка. */
const plain = (text) => String(text ?? '').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

export function logMessage({ userId = null, chatId, direction, text }) {
  return prisma.botMessage.create({ data: { userId, chatId: String(chatId), direction, text: plain(text).slice(0, 4000) } })
    .catch((e) => {
      console.error('[агент] журнал:', e.message)
      return null
    })
}

/** Чат человека или null, если он не подключил телеграм или отключён. */
export async function chatOf(userId) {
  const link = await prisma.telegramLink.findFirst({
    where: { userId, chatId: { not: null }, user: { active: true } },
    select: { chatId: true },
  })
  return link?.chatId ?? null
}

/** Кто по этому чату: связка из CRM. */
export async function userByChat(chatId) {
  const link = await prisma.telegramLink.findFirst({
    where: { chatId: String(chatId) },
    select: { user: { select: { id: true, name: true, role: true, active: true } } },
  })
  return link?.user?.active ? link.user : null
}

/** Написать человеку из CRM. Нет телеграма — тихо пропускаем. */
export async function tell(userId, text, opts = {}) {
  const chatId = await chatOf(userId)
  if (!chatId) return { ok: false, reason: 'no_chat' }
  return tellChat(chatId, text, { ...opts, userId })
}

export async function tellChat(chatId, text, { userId = null, buttons } = {}) {
  const res = await sendMessage(chatId, text, { buttons })
  if (res.ok) await logMessage({ userId, chatId, direction: 'out', text })
  return res
}

/** Владельцы (Ян) с подключённым телеграмом — им идут отчёты. */
export async function ownerIds() {
  const rows = await prisma.user.findMany({
    where: { role: 'admin', active: true, telegram: { chatId: { not: null } } },
    select: { id: true },
  })
  return rows.map((r) => r.id)
}

/** Отчёт владельцу. Никто из владельцев не подключил телеграм — пишем в лог. */
export async function tellOwners(text, opts = {}) {
  const ids = await ownerIds()
  if (!ids.length) console.log(`[агент] отчёт владельцу не ушёл — у владельца нет телеграма: ${plain(text).slice(0, 120)}`)
  for (const id of ids) await tell(id, text, opts)
  return ids.length
}

/**
 * Отправить один раз: ключ «что именно» ложится в BotNotice, второй раз по
 * тому же ключу не уйдёт — ни после перезапуска, ни с другого процесса.
 * Ключ занимаем до отправки: лучше в редком сбое не отправить, чем
 * отправить дважды.
 */
export async function claimNotice(key) {
  try {
    await prisma.botNotice.create({ data: { key } })
    return true
  } catch (e) {
    if (e.code === 'P2002') return false
    throw e
  }
}

export async function hasNotice(key) {
  return Boolean(await prisma.botNotice.findUnique({ where: { key }, select: { key: true } }))
}

/**
 * Кнопка-ссылка в CRM. Телеграм принимает только https и отвергает всё
 * сообщение из-за кривой ссылки — локальный адрес кнопкой не ставим.
 */
export function crmButton(text, path = '/') {
  const base = String(env.clientUrl || '').replace(/\/+$/, '')
  if (!/^https:\/\//.test(base)) return null
  return { text, url: `${base}${path}` }
}

/** Ряд кнопок без пустых мест. */
export const row = (...buttons) => buttons.filter(Boolean)
