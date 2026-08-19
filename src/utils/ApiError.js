export class ApiError extends Error {
  constructor(status, message, details) {
    super(message)
    this.status = status
    this.details = details
  }

  static badRequest(message, details) { return new ApiError(400, message, details) }
  static unauthorized(message = 'Требуется авторизация') { return new ApiError(401, message) }
  static forbidden(message = 'Недостаточно прав') { return new ApiError(403, message) }
  static notFound(message = 'Не найдено') { return new ApiError(404, message) }
  static conflict(message) { return new ApiError(409, message) }
}
