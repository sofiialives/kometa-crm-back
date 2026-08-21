import bcrypt from 'bcryptjs'
import { OAuth2Client } from 'google-auth-library'
import { prisma } from '../config/prisma.js'
import { ApiError } from '../utils/ApiError.js'
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../utils/jwt.js'
import { generateSixDigitCode, hashCode, compareCode } from '../utils/code.js'
import { sendMail, resetCodeEmailText } from '../utils/mailer.js'
import { env } from '../config/env.js'

const googleClient = new OAuth2Client(env.googleClientId)
const NOT_INVITED = 'Админ не подтвердил вашу почту'
const RESET_CODE_TTL_MS = 10 * 60 * 1000

export async function loginWithPassword({ email, password }) {
  const user = await prisma.user.findUnique({ where: { email } })
  if (!user) throw ApiError.forbidden(NOT_INVITED)
  if (!user.active) throw ApiError.unauthorized('Доступ отозван')

  if (user.status === 'invited' || !user.passwordHash) {
    const passwordHash = await bcrypt.hash(password, 10)
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, status: 'active' },
    })
    return issueTokens(updated)
  }

  const ok = await bcrypt.compare(password, user.passwordHash)
  if (!ok) throw ApiError.unauthorized('Неверный email или пароль')
  return issueTokens(user)
}

export async function loginWithGoogle({ idToken }) {
  if (!env.googleClientId) {
    throw ApiError.badRequest('GOOGLE_CLIENT_ID не настроен на сервере (.env)')
  }

  let payload
  try {
    const ticket = await googleClient.verifyIdToken({ idToken, audience: env.googleClientId })
    payload = ticket.getPayload()
  } catch (err) {
    throw ApiError.badRequest(
      'Google отклонил токен: ' + (err.message || 'токен недействителен или просрочен'),
    )
  }
  if (!payload?.email) throw ApiError.unauthorized('Не удалось подтвердить аккаунт Google')

  const user = await prisma.user.findUnique({ where: { email: payload.email.toLowerCase() } })
  if (!user) throw ApiError.forbidden(NOT_INVITED)
  if (!user.active) throw ApiError.unauthorized('Доступ отозван')

  const patch = {}
  if (!user.googleId) patch.googleId = payload.sub

  if (user.status !== 'active') {
    // Только первый настоящий вход: имя-заглушку (первая буква почты)
    // меняем на реальные имя и фото из Google. Дальше это уже личный
    // выбор человека — если он потом уберёт фото или поставит цвет
    // в настройках, повторный вход через Google не должен это стирать.
    patch.status = 'active'
    if (payload.name) patch.name = payload.name
    if (payload.picture) patch.avatarUrl = payload.picture
  }

  const updated = Object.keys(patch).length
    ? await prisma.user.update({ where: { id: user.id }, data: patch })
    : user

  return issueTokens(updated)
}

/**
 * Код отправляем только тем, кто уже завершил первый вход (status: active).
 * Если человека только пригласили и он ни разу не логинился — пароля ещё
 * нет, восстанавливать нечего, письмо не шлём.
 */
export async function requestPasswordReset(email) {
  const user = await prisma.user.findUnique({ where: { email } })
  if (!user || !user.active || user.status !== 'active') return

  const code = generateSixDigitCode()
  const resetCodeHash = await hashCode(code)
  await prisma.user.update({
    where: { id: user.id },
    data: { resetCodeHash, resetCodeExpires: new Date(Date.now() + RESET_CODE_TTL_MS) },
  })

  await sendMail(user.email, 'Код для восстановления пароля', resetCodeEmailText(code))
}

export async function resetPassword({ email, code, newPassword }) {
  const user = await prisma.user.findUnique({ where: { email } })
  if (!user || !user.resetCodeHash || !user.resetCodeExpires) {
    throw ApiError.badRequest('Код недействителен')
  }
  if (user.resetCodeExpires.getTime() < Date.now()) {
    throw ApiError.badRequest('Код истёк, запросите новый')
  }
  const ok = await compareCode(code, user.resetCodeHash)
  if (!ok) throw ApiError.badRequest('Неверный код')

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: await bcrypt.hash(newPassword, 10),
      status: 'active',
      resetCodeHash: null,
      resetCodeExpires: null,
    },
  })

  return issueTokens(updated)
}

export async function refreshTokens(refreshToken) {
  if (!refreshToken) throw ApiError.unauthorized()
  let payload
  try {
    payload = verifyRefreshToken(refreshToken)
  } catch {
    throw ApiError.unauthorized('Сессия истекла')
  }
  const user = await prisma.user.findUnique({ where: { id: payload.sub } })
  if (!user || !user.active) throw ApiError.unauthorized()
  return issueTokens(user)
}

function issueTokens(user) {
  const publicUser = {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    position: user.position ?? null,
    departmentId: user.departmentId,
    status: user.status,
    avatarUrl: user.avatarUrl ?? null,
    avatarColor: user.avatarColor ?? null,
  }
  return {
    user: publicUser,
    accessToken: signAccessToken(publicUser),
    refreshToken: signRefreshToken(publicUser),
  }
}