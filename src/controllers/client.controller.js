import { asyncHandler } from '../utils/asyncHandler.js'
import * as clientService from '../services/client.service.js'

export const listClients = asyncHandler(async (req, res) => {
  res.json(await clientService.listClients())
})

export const createClient = asyncHandler(async (req, res) => {
  res.status(201).json(await clientService.createClient(req.body.name))
})

export const updateClient = asyncHandler(async (req, res) => {
  res.json(await clientService.updateClient(req.params.id, req.body.name))
})

export const deleteClient = asyncHandler(async (req, res) => {
  const result = await clientService.deleteClient(req.params.id)
  res.json(result)
})
