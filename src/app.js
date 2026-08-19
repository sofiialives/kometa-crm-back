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
  app.use(express.json())
  app.use(cookieParser())
  app.use(morgan(env.nodeEnv === 'development' ? 'dev' : 'combined'))

  app.get('/health', (req, res) => res.json({ ok: true }))
  app.use('/api', routes)

  app.use(notFoundHandler)
  app.use(errorHandler)

  return app
}
