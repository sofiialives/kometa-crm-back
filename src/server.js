import { createApp } from './app.js'
import { connectDb } from './config/db.js'
import { env } from './config/env.js'
import { scheduleClearFinishedTasks } from './jobs/clearFinishedTasks.job.js'

async function bootstrap() {
  await connectDb()
  scheduleClearFinishedTasks()

  const app = createApp()
  app.listen(env.port, () => {
    console.log(`[server] KOMETA CRM API запущен на порту ${env.port}`)
  })
}

bootstrap().catch((err) => {
  console.error('[server] не удалось запуститься:', err)
  process.exit(1)
})
