import { ApiError } from '../utils/ApiError.js'
import { env } from '../config/env.js'

export function notFoundHandler(req, res, next) {
  next(ApiError.notFound(`Маршрут ${req.method} ${req.originalUrl} не найден`))
}

export function errorHandler(err, req, res, next) {
  const status = err instanceof ApiError ? err.status : 500
  const message = err instanceof ApiError ? err.message : 'Внутренняя ошибка сервера'

  if (status === 500) console.error(err)

  res.status(status).json({
    error: {
      message,
      details: err.details,
      ...(env.nodeEnv === 'development' && status === 500 ? { stack: err.stack } : {}),
    },
  })
}
