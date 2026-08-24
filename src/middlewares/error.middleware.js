import { ApiError } from '../utils/ApiError.js'
import { normalizeError } from '../utils/httpErrors.js'
import { env } from '../config/env.js'

export function notFoundHandler(req, res, next) {
  next(ApiError.notFound(`Маршрут ${req.method} ${req.originalUrl} не найден`))
}

export function errorHandler(err, req, res, next) {
  const normalized = normalizeError(err)
  const status = normalized instanceof ApiError ? normalized.status : 500
  const wasRaw = !(err instanceof ApiError) // пришло из Prisma/JWT/т.п., не наш осознанный throw

  const message =
    normalized instanceof ApiError
      ? normalized.message
      : env.nodeEnv === 'development'
        ? err.message || 'Внутренняя ошибка сервера'
        : 'Внутренняя ошибка сервера'

  // 500 — всегда в консоль. Но и "сырые" ошибки, которые мы на лету
  // превратили в 400/404 и т.п., тоже стоит видеть в терминале в dev —
  // иначе единственный след останется в morgan-логе одной строкой без
  // деталей, и разбираться придётся вслепую.
  if (status === 500 || (wasRaw && env.nodeEnv === 'development')) {
    console.error(err)
  }

  res.status(status).json({
    error: {
      message,
      details: normalized instanceof ApiError ? normalized.details : undefined,
      ...(env.nodeEnv === 'development' && status === 500 ? { stack: err.stack } : {}),
    },
  })
}
