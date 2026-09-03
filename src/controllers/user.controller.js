import { asyncHandler } from '../utils/asyncHandler.js'
import * as userService from '../services/user.service.js'

export const listUsers = asyncHandler(async (req, res) => {
  const users = await userService.listUsers({ departmentId: req.query.departmentId }, req.user)
  res.json(users)
})

export const inviteUser = asyncHandler(async (req, res) => {
  const user = await userService.inviteUser(req.body)
  res.status(201).json(user)
})

export const updateUser = asyncHandler(async (req, res) => {
  const user = await userService.updateUser(req.params.id, req.body)
  res.json(user)
})

export const deactivateUser = asyncHandler(async (req, res) => {
  const user = await userService.deactivateUser(req.params.id, req.user.id)
  res.json(user)
})

export const listTaskStats = asyncHandler(async (req, res) => {
  res.json(await userService.listTaskStats())
})