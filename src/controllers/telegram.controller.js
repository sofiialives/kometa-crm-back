import { asyncHandler } from '../utils/asyncHandler.js'
import * as telegramService from '../services/telegram.service.js'

export const getStatus = asyncHandler(async (req, res) => {
  res.json(await telegramService.getStatus(req.user.id))
})

export const issueCode = asyncHandler(async (req, res) => {
  res.json(await telegramService.issueCode(req.user.id))
})

export const unlink = asyncHandler(async (req, res) => {
  await telegramService.unlink(req.user.id)
  res.status(204).send()
})
