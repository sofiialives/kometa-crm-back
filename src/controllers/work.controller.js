import { asyncHandler } from '../utils/asyncHandler.js'
import * as workService from '../services/work.service.js'

export const listWorks = asyncHandler(async (req, res) => {
  res.json(await workService.listWorksVisibleTo(req.user))
})

export const createWork = asyncHandler(async (req, res) => {
  const work = await workService.createWork({ ...req.body, createdBy: req.user.id })
  res.status(201).json(work)
})

export const updateWork = asyncHandler(async (req, res) => {
  res.json(await workService.updateWork(req.params.id, req.body, req.user))
})

export const deleteWork = asyncHandler(async (req, res) => {
  await workService.deleteWork(req.params.id, req.user)
  res.status(204).send()
})
