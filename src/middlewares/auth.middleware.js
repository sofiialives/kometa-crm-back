import { verifyAccessToken } from '../utils/jwt.js'
import { ApiError } from '../utils/ApiError.js'
import { User } from '../models/User.js'
import { asyncHandler } from '../utils/asyncHandler.js'

export const authenticate = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) throw ApiError.unauthorized()

  let payload
  try {
    payload = verifyAccessToken(token)
  } catch {
    throw ApiError.unauthorized('Токен недействителен или истёк')
  }

  const user = await User.findById(payload.sub)
  if (!user || !user.active) throw ApiError.unauthorized('Доступ отозван')

  req.user = {
    id: user.id,
    role: user.role,
    departmentId: user.departmentId ? String(user.departmentId) : null,
  }
  next()
})

export function authorize(...roles) {
  return (req, res, next) => {
    if (!req.user) return next(ApiError.unauthorized())
    if (!roles.includes(req.user.role)) return next(ApiError.forbidden())
    next()
  }
}
