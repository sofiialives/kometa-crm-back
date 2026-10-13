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

/** Отметки «уже отправил» старше трёх месяцев больше не нужны. */
export async function pruneNotices(now = new Date()) {
  const { count } = await prisma.botNotice.deleteMany({
    where: { sentAt: { lt: new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000) }, NOT: { key: { startsWith: 'feed:' } } },
  })
  if (count) console.log(`[агент] старых отметок удалено: ${count}`)
}
