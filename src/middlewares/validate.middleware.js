import { ApiError } from '../utils/ApiError.js'

export function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse({ body: req.body, query: req.query, params: req.params })
    if (!result.success) {
      return next(ApiError.badRequest('Ошибка валидации', result.error.flatten()))
    }
    if (result.data.body) req.body = result.data.body
    if (result.data.query) req.query = result.data.query
    if (result.data.params) req.params = result.data.params
    next()
  }
}
