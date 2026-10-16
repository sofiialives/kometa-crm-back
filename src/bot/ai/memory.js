import { prisma } from '../../config/prisma.js'
import { hm } from '../agent/format.js'
import { cut, plain } from './limits.js'

/**
 * Память агента — переписка человека с ботом за последние сутки, в виде
 * разговора: что писал человек и что отвечал бот (и шаблоны бота тоже,
 * чтобы агент знал, что человеку уже сказали). Картинки из прошлых
 * сообщений — пометкой: заново слать их модели дорого, а что на них,
 * агент уже сказал в своём ответе.
 */

const WINDOW_MS = 24 * 60 * 60 * 1000
const FILE_WORD = { photo: 'фото', document: 'файл', video: 'видео', voice: 'голосовое', video_note: 'кружок', audio: 'аудио', animation: 'гифка' }

export function fileWord(kind) {
  return FILE_WORD[kind] ?? 'файл'
}

// Что бот писал сам — ответ агента или сообщение по поручению, которое
// утвердил Ян. Остальное от бота — уведомления, в них слова сотрудников.
const OWN_WORDS = new Set(['ai', 'round'])

/**
 * Строка истории в реплику разговора: { role, text }. strict — для Яна и
 * руководителя: уведомления о людях (отлучки, заявки, отчёты) несут слова
 * сотрудников, их нельзя выдавать модели за её собственные реплики —
 * идут пометкой «уведомление бота», одной строкой.
 */
export function turnOf(m, { strict = false } = {}) {
  if (m.direction === 'out' && strict && !OWN_WORDS.has(m.source)) {
    return { role: 'user', text: `[${hm(m.createdAt)}] уведомление бота, данные: ${plain(m.text, 300)}` }
  }
  const text = cut(String(m.text ?? ''), m.direction === 'out' ? 700 : 500)
  if (m.direction === 'out') return { role: 'assistant', text }
  if (m.direction === 'button') return { role: 'user', text: `[${hm(m.createdAt)}] нажал кнопку «${text}»` }
  const file = m.fileId && !/^\[[^\]]+\]$/.test(text) ? ` [${fileWord(m.fileKind)}]` : ''
  return { role: 'user', text: `[${hm(m.createdAt)}] ${text}${file}` }
}

/**
 * Реплики подряд от одной стороны склеиваем в одну. Разговор в API
 * начинается с человека: если первым писал бот (напоминание, вопрос по
 * поручению), ставим перед ним пометку, а не выбрасываем — иначе агент
 * не знал бы, на что ему отвечают. current — содержимое нового сообщения
 * (блоки): оно последнее.
 */
export function toMessages(rows, current, { strict = false } = {}) {
  const turns = []
  for (const m of rows) {
    const t = turnOf(m, { strict })
    const last = turns.at(-1)
    if (last?.role === t.role) last.text += `\n${t.text}`
    else turns.push({ ...t })
  }
  if (turns[0]?.role === 'assistant') turns.unshift({ role: 'user', text: '[раньше в переписке]' })
  const messages = turns.map((t) => ({ role: t.role, content: [{ type: 'text', text: t.text }] }))
  if (messages.at(-1)?.role === 'user') messages.at(-1).content.push(...current)
  else messages.push({ role: 'user', content: current })
  return messages
}

/** Последние сообщения переписки, кроме тех, что пришли сейчас. */
export async function recentRows(userId, { exceptIds = [], take = 14, now = new Date() } = {}) {
  const rows = await prisma.botMessage.findMany({
    where: {
      userId,
      createdAt: { gte: new Date(now.getTime() - WINDOW_MS) },
      ...(exceptIds.length ? { id: { notIn: exceptIds } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take,
    select: { direction: true, text: true, createdAt: true, fileId: true, fileKind: true, source: true },
  })
  return rows.reverse()
}
