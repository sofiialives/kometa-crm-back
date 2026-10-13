import { prisma } from '../../config/prisma.js'
import { tickBreaks } from './away.js'
import { tickCheckin } from './checkin.js'
import { tickFeed } from './feed.js'
import { morningNoTasks, tickTaskStarts } from './tasks.js'

/**
 * Агент — часть бота напоминаний: раз в минуту обходит отлучки, задачи,
 * чек-ин и ленту изменений. Проход не накладывается сам на себя: если
 * прошлый ещё идёт, этот пропускается.
 */

let running = false

const STEPS = [
  ['отлучки', tickBreaks],
  ['задачи', tickTaskStarts],
  ['чек-ин', tickCheckin],
  ['лента', tickFeed],
]

export async function runAgentOnce(now = new Date()) {
  if (running) return
  running = true
  try {
    for (const [name, step] of STEPS) {
      await step(now).catch((e) => console.error(`[агент] ${name}:`, e.message))
    }
  } finally {
    running = false
  }
}

export async function runMorning(now = new Date()) {
  const sent = await morningNoTasks(now)
  console.log(`[агент] утро: без задач на сегодня — ${sent}`)
}

/**
 * Отметки «уже отправил» и переписка старше трёх месяцев больше не нужны.
 * Переписку дольше и не храним: в ней бывает личное («заболел»).
 */
export async function pruneNotices(now = new Date()) {
  const before = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000)
  // Отметки заявок и работ не трогаем: заявка может висеть дольше трёх
  // месяцев, и без отметки она ушла бы Яну второй раз.
  const notices = await prisma.botNotice.deleteMany({
    where: {
      sentAt: { lt: before },
      NOT: [{ key: { startsWith: 'feed:' } }, { key: { startsWith: 'review:' } }, { key: { startsWith: 'hint:' } }],
    },
  })
  const messages = await prisma.botMessage.deleteMany({ where: { createdAt: { lt: before } } })
  // В журнале действий факт остаётся, а слова человека — нет.
  const words = await prisma.botEvent.updateMany({ where: { at: { lt: before }, text: { not: null } }, data: { text: null } })
  if (notices.count || messages.count || words.count) {
    console.log(`[агент] уборка: отметок ${notices.count}, сообщений ${messages.count}, слов в журнале ${words.count}`)
  }
}
