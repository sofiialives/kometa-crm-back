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

/**
 * direction: out — от бота; in — человек написал сам; reply — ответ на
 * вопрос бота; button — нажатая кнопка. В дневной лимит идут только in.
 */
export function logMessage({ userId = null, chatId, direction, text }) {
  // Своё сообщение бот пишет в HTML — теги убираем. Человек пишет как есть:
  // «1 < 2» должно остаться «1 < 2».
  const clean = direction === 'out' ? plain(text) : String(text ?? '')
  return prisma.botMessage.create({ data: { userId, chatId: String(chatId), direction, text: clean.slice(0, 4000) } })
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
  // Один чат — один человек: при привязке чат снимается с прежних связок.
  // На случай старых двойных связок берём самую свежую.
  const link = await prisma.telegramLink.findFirst({
    where: { chatId: String(chatId) },
    orderBy: { linkedAt: 'desc' },
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

/**
 * Отчёт владельцу. Никто из владельцев не подключил телеграм — пишем в лог.
 * { ok, retry }: ok — дошло хотя бы до одного; retry — не дошло ни до кого
 * из-за временного сбоя, можно повторить.
 */
export async function tellOwners(text, opts = {}) {
  const ids = await ownerIds()
  if (!ids.length) {
    console.log(`[агент] отчёт владельцу не ушёл — у владельца нет телеграма: ${plain(text).slice(0, 120)}`)
    return { ok: false, retry: false }
  }
  let ok = false
  let retry = false
  for (const id of ids) {
    const res = await tell(id, text, opts)
    ok ||= res.ok
    retry ||= Boolean(res.retry)
  }
  return { ok, retry: !ok && retry }
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

/** Вернуть ключ: отправка сорвалась временно, следующий проход попробует снова. */
export async function releaseNotice(key) {
  await prisma.botNotice.delete({ where: { key } }).catch(() => {})
}

/**
 * Отправить один раз: занять ключ, отправить, при временном сбое — вернуть
 * ключ. send — функция, которая отправляет и отдаёт { ok, retry }.
 */
export async function sendOnce(key, send) {
  // Сначала смотрим — так повторные проходы не долбят базу заведомо
  // неудачными вставками.
  if ((await hasNotice(key)) || !(await claimNotice(key))) return { ok: false, skipped: true }
  try {
    const res = await send()
    if (!res?.ok && res?.retry) await releaseNotice(key)
    return res
  } catch (e) {
    await releaseNotice(key)
    throw e
  }
}

/** Какие из ключей ещё не отправлены — одним запросом, без лишних вставок. */
export async function unsentKeys(keys) {
  if (!keys.length) return new Set()
  const taken = await prisma.botNotice.findMany({ where: { key: { in: keys } }, select: { key: true } })
  const done = new Set(taken.map((t) => t.key))
  return new Set(keys.filter((k) => !done.has(k)))
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
