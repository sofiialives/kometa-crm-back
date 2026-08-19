import bcrypt from 'bcryptjs'
import { OAuth2Client } from 'google-auth-library'
import { User } from '../models/User.js'
import { ApiError } from '../utils/ApiError.js'
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../utils/jwt.js'
import { env } from '../config/env.js'

const googleClient = new OAuth2Client(env.googleClientId)

export async function loginWithPassword({ email, password }) {
  const user = await User.findOne({ email }).select('+passwordHash')
  if (!user || !user.active || !user.passwordHash) throw ApiError.unauthorized('Неверный email или пароль')

  const ok = await bcrypt.compare(password, user.passwordHash)
  if (!ok) throw ApiError.unauthorized('Неверный email или пароль')

  return issueTokens(user)
}

export async function loginWithGoogle({ idToken }) {
  const ticket = await googleClient.verifyIdToken({ idToken, audience: env.googleClientId })
  const payload = ticket.getPayload()
  if (!payload?.email) throw ApiError.unauthorized('Не удалось подтвердить аккаунт Google')

  let user = await User.findOne({ email: payload.email.toLowerCase() })
  if (!user) {
    throw ApiError.forbidden('Доступ не выдан. Обратитесь к администратору')
  }
  if (!user.active) throw ApiError.unauthorized('Доступ отозван')

  if (!user.googleId) {
    user.googleId = payload.sub
    await user.save()
  }

  return issueTokens(user)
}

export async function refreshTokens(refreshToken) {
  if (!refreshToken) throw ApiError.unauthorized()
  let payload
  try {
    payload = verifyRefreshToken(refreshToken)
  } catch {
    throw ApiError.unauthorized('Сессия истекла')
  }
  const user = await User.findById(payload.sub)
  if (!user || !user.active) throw ApiError.unauthorized()
  return issueTokens(user)
}

function issueTokens(user) {
  const publicUser = {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    departmentId: user.departmentId ? String(user.departmentId) : null,
  }
  return {
    user: publicUser,
    accessToken: signAccessToken(publicUser),
    refreshToken: signRefreshToken(publicUser),
  }
}
