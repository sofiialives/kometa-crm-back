import express from 'express'
import cors from 'cors'
import morgan from 'morgan'
import cookieParser from 'cookie-parser'
import { env } from './config/env.js'
import routes from './routes/index.js'
import { notFoundHandler, errorHandler } from './middlewares/error.middleware.js'

export function createApp() {
  const app = express()

  app.use(cors({ origin: env.clientUrl, credentials: true }))
  // Дефолтный лимит express.json() — 100kb, туда не влезет фото аватарки
  // в виде base64 (храним прямо в avatarUrl, без внешнего хранилища файлов).
  app.use(express.json({ limit: '3mb' }))
  app.use(cookieParser())
  app.use(morgan(env.nodeEnv === 'development' ? 'dev' : 'combined'))

  app.get('/health', (req, res) => res.json({ ok: true }))
  app.use('/api', routes)

  app.use(notFoundHandler)
  app.use(errorHandler)

  return app
}
