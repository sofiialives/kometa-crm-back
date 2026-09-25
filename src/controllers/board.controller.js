import { asyncHandler } from '../utils/asyncHandler.js'
import * as boardService from '../services/board.service.js'

export const getBoard = asyncHandler(async (req, res) => {
  res.json(await boardService.getBoard(req.user, req.query))
})

export const getCard = asyncHandler(async (req, res) => {
  res.json(await boardService.getCard(req.user, req.params.id, req.query))
})

export const listMonths = asyncHandler(async (req, res) => {
  res.json(await boardService.listMonths(req.user))
})

export const addClient = asyncHandler(async (req, res) => {
  res.status(201).json(await boardService.addClient(req.user, req.body))
})

export const editClient = asyncHandler(async (req, res) => {
  res.json(await boardService.editClient(req.user, req.params.id, req.body))
})

export const markLeft = asyncHandler(async (req, res) => {
  res.json(await boardService.markLeft(req.user, req.params.id, req.body))
})

export const markActive = asyncHandler(async (req, res) => {
  res.json(await boardService.markActive(req.user, req.params.id))
})

export const removeClient = asyncHandler(async (req, res) => {
  await boardService.removeClient(req.user, req.params.id)
  res.status(204).send()
})

export const addService = asyncHandler(async (req, res) => {
  res.status(201).json(await boardService.addService(req.user, req.body))
})

export const editService = asyncHandler(async (req, res) => {
  res.json(await boardService.editService(req.user, req.params.id, req.body))
})

export const removeService = asyncHandler(async (req, res) => {
  await boardService.removeService(req.user, req.params.id)
  res.status(204).send()
})
