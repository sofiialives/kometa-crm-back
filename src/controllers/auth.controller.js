import { asyncHandler } from '../utils/asyncHandler.js'
import * as authService from '../services/auth.service.js'
import { User } from '../models/User.js'

export const login = asyncHandler(async (req, res) => {
  const result = await authService.loginWithPassword(req.body)
  res.json(result)
})

export const loginGoogle = asyncHandler(async (req, res) => {
  const result = await authService.loginWithGoogle(req.body)
  res.json(result)
})

export const refresh = asyncHandler(async (req, res) => {
  const token = req.body.refreshToken || req.cookies?.refreshToken
  const result = await authService.refreshTokens(token)
  res.json(result)
})

export const me = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id)
  res.json({ id: user.id, name: user.name, email: user.email, role: user.role, departmentId: user.departmentId })
})

export const logout = asyncHandler(async (req, res) => {
  res.status(204).send()
})
