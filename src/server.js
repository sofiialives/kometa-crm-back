import { createApp } from './app.js'
import { connectDb } from './config/db.js'
import { env } from './config/env.js'
import { scheduleClearFinishedTasks } from './jobs/clearFinishedTasks.job.js'
import { scheduleClearPastCalls } from './jobs/clearPastCalls.job.js'
import { startBot } from './bot/index.js'

async function bootstrap() {
  await connectDb()
  scheduleClearFinishedTasks()
  scheduleClearPastCalls()
  // Бот напоминаний. Ошибка внутри него не должна мешать серверу
  // подняться, поэтому запускаем без await и с ловушкой.
  startBot().catch((e) => console.error('[бот] сбой запуска:', e.message))

  const app = createApp()
  app.listen(env.port, () => {
    console.log(`[server] KOMETA CRM API запущен на порту ${env.port}`)
  })
}

bootstrap().catch((err) => {
  console.error('[server] не удалось запуститься:', err)
  process.exit(1)
})
