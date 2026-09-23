import { asyncHandler } from '../utils/asyncHandler.js'
import * as callService from '../services/call.service.js'

export const listCalls = asyncHandler(async (req, res) => {
  const calls = await callService.listCallsVisibleTo(req.user, { scope: req.query.scope, departmentId: req.query.departmentId })
  res.json(calls)
})

export const createCall = asyncHandler(async (req, res) => {
  const call = await callService.createCall({ ...req.body, user: req.user })
  res.status(201).json(call)
})

export const editCall = asyncHandler(async (req, res) => {
  const call = await callService.editCall(req.params.id, req.body, req.user)
  res.json(call)
})

export const deleteCall = asyncHandler(async (req, res) => {
  await callService.deleteCall(req.params.id, req.user)
  res.status(204).send()
})
