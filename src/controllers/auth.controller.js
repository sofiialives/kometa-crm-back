import { asyncHandler } from '../utils/asyncHandler.js'
import * as authService from '../services/auth.service.js'
import { prisma } from '../config/prisma.js'

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
    status: user.status, avatarUrl: user.avatarUrl,
  })
})

/**
 * Единственное, что человек может поменять сам себе без прав админа —
 * собственное имя. После первого входа бэк ставит только первую букву
 * почты вместо имени, и без этого эндпоинта её нечем заменить —
 * обычный PATCH /users/:id закрыт для всех, кроме админа.
 */
export const updateMe = asyncHandler(async (req, res) => {
  const user = await prisma.user.update({
    where: { id: req.user.id },
    data: { name: req.body.name },
  })
  res.json({
    id: user.id, name: user.name, email: user.email,
    role: user.role, position: user.position, departmentId: user.departmentId,
    status: user.status, avatarUrl: user.avatarUrl,
  })
})

export const logout = asyncHandler(async (req, res) => {
  res.status(204).send()
})
