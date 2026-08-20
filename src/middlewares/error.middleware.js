import { ApiError } from '../utils/ApiError.js'
import { normalizeError } from '../utils/httpErrors.js'
import { env } from '../config/env.js'

export function notFoundHandler(req, res, next) {
  next(ApiError.notFound(`Маршрут ${req.method} ${req.originalUrl} не найден`))
}

export function errorHandler(err, req, res, next) {
  const normalized = normalizeError(err)
  const status = normalized instanceof ApiError ? normalized.status : 500

  const message =
    normalized instanceof ApiError
      ? normalized.message
      : env.nodeEnv === 'development'
        ? err.message || 'Внутренняя ошибка сервера'
        : 'Внутренняя ошибка сервера'

  if (status === 500) console.error(err)

  res.status(status).json({
    error: {
      message,
      details: normalized instanceof ApiError ? normalized.details : undefined,
      ...(env.nodeEnv === 'development' && status === 500 ? { stack: err.stack } : {}),
    },
  })
}
