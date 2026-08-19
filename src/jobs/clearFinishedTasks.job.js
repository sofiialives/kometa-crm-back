import cron from 'node-cron'
import { Task } from '../models/Task.js'

export function scheduleClearFinishedTasks() {
  cron.schedule('0 0 * * *', async () => {
    const res = await Task.deleteMany({ status: 'done' })
    console.log('[cron] удалено выполненных задач за день:', res.deletedCount)
  })

  cron.schedule('0 0 * * *', async () => {
    const res = await Task.deleteMany({ status: { $ne: 'done' }, deadline: { $lt: new Date() } })
    console.log('[cron] удалено просроченных незакрытых задач:', res.deletedCount)
  })
}
