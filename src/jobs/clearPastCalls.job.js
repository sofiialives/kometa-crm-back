import cron from 'node-cron'
import { prisma } from '../config/prisma.js'

/**
 * Отдельный файл, а не третий cron в clearFinishedTasks.job.js — намеренно.
 * Тот файл управляет удалением задач на бою, и трогать его ради звонков
 * значило бы рисковать тем, что уже работает. Здесь ничего, кроме таблицы
 * Call, не упоминается в принципе.
 */
export function scheduleClearPastCalls() {
  // Тот же часовой пояс, что и у задач: без него node-cron взял бы пояс
  // сервера (на Render это UTC) и чистил бы в 3 ночи по Москве.
  const TZ = { timezone: 'Europe/Moscow' }

  cron.schedule('0 0 * * *', async () => {
    // Срабатывает ровно в полночь по МСК, поэтому scheduledAt < сейчас —
    // это звонки вчерашнего дня и старше. Сегодняшние и будущие не
    // затрагиваются: на момент запуска сегодняшний день только начался.
    const res = await prisma.call.deleteMany({
      where: { scheduledAt: { lt: new Date() } },
    })
    console.log('[cron] удалено прошедших звонков:', res.count)
  }, TZ)
}
