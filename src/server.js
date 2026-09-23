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

  const app = createApp()
  app.listen(env.port, () => {
    console.log(`[server] KOMETA CRM API запущен на порту ${env.port}`)

    // Бот стартует только после того, как порт реально занят. Если
    // процесс не смог подняться — например, порт уже держит другой
    // экземпляр, — он не должен тянуть getUpdates: телеграм отдаёт
    // очередь одному подключению и рвёт остальные, поэтому два живых
    // экземпляра означают, что не работает ни один.
    //
    // Ошибка внутри бота не должна ронять API, поэтому с ловушкой.
    startBot().catch((e) => console.error('[бот] сбой запуска:', e.message))
  })
}

bootstrap().catch((err) => {
  console.error('[server] не удалось запуститься:', err)
  process.exit(1)
})
