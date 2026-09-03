import cron from 'node-cron'
import { prisma } from '../config/prisma.js'

async function bumpStat(field, tasks) {
  const byUser = {}
  for (const t of tasks) byUser[t.ownerId] = (byUser[t.ownerId] || 0) + 1

  for (const [userId, count] of Object.entries(byUser)) {
    await prisma.userTaskStat.upsert({
      where: { userId },
      create: { userId, [field]: count },
      update: { [field]: { increment: count } },
    })
  }
}

export function scheduleClearFinishedTasks() {
  // timezone: 'Europe/Moscow' — без этого node-cron берёт часовой пояс
  // СЕРВЕРА (на Render это обычно UTC), а не Москвы. "0 0 * * *" без
  // явного пояса срабатывал в полночь по UTC — то есть в 3 часа ночи
  // по Москве, хотя весь остальной интерфейс показывает время как МСК.
  const TZ = { timezone: 'Europe/Moscow' }

  cron.schedule('0 0 * * *', async () => {
    const doneTasks = await prisma.task.findMany({
      where: { status: 'done', origin: 'personal', owner: { role: { not: 'admin' } } },
      select: { ownerId: true },
    })
    await bumpStat('doneCount', doneTasks)

    const res = await prisma.task.deleteMany({
      where: { status: 'done', origin: 'personal', owner: { role: { not: 'admin' } } },
    })
    console.log('[cron] удалено выполненных задач за день:', res.count)
  }, TZ)

  cron.schedule('0 0 * * *', async () => {
    const overdueTasks = await prisma.task.findMany({
      where: {
        status: { not: 'done' },
        deadline: { lt: new Date() },
        origin: 'personal',
        owner: { role: { not: 'admin' } },
      },
      select: { ownerId: true },
    })
    await bumpStat('overdueCount', overdueTasks)

    const res = await prisma.task.deleteMany({
      where: {
        status: { not: 'done' },
        deadline: { lt: new Date() },
        origin: 'personal',
        owner: { role: { not: 'admin' } },
      },
    })
    console.log('[cron] удалено просроченных незакрытых задач:', res.count)
  }, TZ)
}