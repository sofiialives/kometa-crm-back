import { ApiError } from '../utils/ApiError.js'

/**
 * "Ошибка валидации" сама по себе ничего не говорит — реальная причина
 * пряталась в details, которые фронт не показывал. zod.flatten() режет
 * путь до верхнего уровня (body/query/params), реальное поле вроде
 * clientId терялось — поэтому берём issues напрямую, там путь полный.
 * details оставляем рядом для отладки.
 */
export function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse({ body: req.body, query: req.query, params: req.params })
    if (!result.success) {
      const issue = result.error.issues[0]
      const path = issue?.path.filter((p) => !['body', 'query', 'params'].includes(p)).join('.')
      const message = issue ? `Ошибка валидации — ${path || 'данные'}: ${issue.message}` : 'Ошибка валидации'
      return next(ApiError.badRequest(message, result.error.flatten()))
    }
    if (result.data.body) req.body = result.data.body
    if (result.data.query) req.query = result.data.query
    if (result.data.params) req.params = result.data.params
    next()
  }
}
