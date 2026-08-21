import { asyncHandler } from '../utils/asyncHandler.js'
import * as authService from '../services/auth.service.js'
import { prisma } from '../config/prisma.js'
import bcrypt from 'bcryptjs'
import { ApiError } from '../utils/ApiError.js'

export const login = asyncHandler(async (req, res) => {
  const result = await authService.loginWithPassword(req.body)
  res.json(result)
})

export const loginGoogle = asyncHandler(async (req, res) => {
  const result = await authService.loginWithGoogle(req.body)
  res.json(result)
})

export const forgotPassword = asyncHandler(async (req, res) => {
  await authService.requestPasswordReset(req.body.email)
  res.json({ message: 'Если почта известна системе, код отправлен' })
})

export const resetPassword = asyncHandler(async (req, res) => {
  const result = await authService.resetPassword(req.body)
  res.json(result)
})

export const refresh = asyncHandler(async (req, res) => {
  const token = req.body.refreshToken || req.cookies?.refreshToken
  const result = await authService.refreshTokens(token)
  res.json(result)
})

export const me = asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id } })
  res.json({
    id: user.id, name: user.name, email: user.email,
    role: user.role, position: user.position, departmentId: user.departmentId,
    status: user.status, avatarUrl: user.avatarUrl, avatarColor: user.avatarColor,
  })
})

/**
 * Единственное, что человек может поменять сам себе без прав админа —
 * собственный профиль: имя, фото (data URL — храним прямо в базе, без
 * внешнего хранилища файлов) и цвет кружка-аватарки, когда фото нет.
 * Обычный PATCH /users/:id закрыт для всех, кроме админа.
 */
export const updateMe = asyncHandler(async (req, res) => {
  const { name, avatarUrl, avatarColor } = req.body
  const user = await prisma.user.update({
    where: { id: req.user.id },
    data: {
      ...(name !== undefined ? { name } : {}),
      ...(avatarUrl !== undefined ? { avatarUrl: avatarUrl || null } : {}),
      ...(avatarColor !== undefined ? { avatarColor: avatarColor || null } : {}),
    },
  })
  res.json({
    id: user.id, name: user.name, email: user.email,
    role: user.role, position: user.position, departmentId: user.departmentId,
    status: user.status, avatarUrl: user.avatarUrl, avatarColor: user.avatarColor,
  })
})

/**
 * Смена пароля в уже авторизованной сессии — отдельно от «Забыли пароль»
 * (там код с почты, тут подтверждение текущим паролем). Если у человека
 * пароля ещё нет вообще (входил только через Google) — currentPassword
 * не проверяем, потому что сравнивать не с чем.
 */
export const changePassword = asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id } })

  if (user.passwordHash) {
    const ok = await bcrypt.compare(req.body.currentPassword || '', user.passwordHash)
    if (!ok) throw ApiError.badRequest('Текущий пароль неверный')
  }

  const passwordHash = await bcrypt.hash(req.body.newPassword, 10)
  await prisma.user.update({ where: { id: req.user.id }, data: { passwordHash } })
  res.status(204).send()
})

export const logout = asyncHandler(async (req, res) => {
  res.status(204).send()
})
