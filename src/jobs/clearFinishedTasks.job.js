import cron from 'node-cron'
import { prisma } from '../config/prisma.js'

export function scheduleClearFinishedTasks() {
  cron.schedule('0 0 * * *', async () => {
    const res = await prisma.task.deleteMany({ where: { status: 'done' } })
    console.log('[cron] удалено выполненных задач за день:', res.count)
  })

  cron.schedule('0 0 * * *', async () => {
    const res = await prisma.task.deleteMany({
      where: { status: { not: 'done' }, deadline: { lt: new Date() } },
    })
    console.log('[cron] удалено просроченных незакрытых задач:', res.count)
  })
}
