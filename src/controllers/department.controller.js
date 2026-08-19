import { asyncHandler } from '../utils/asyncHandler.js'
import * as departmentService from '../services/department.service.js'

export const listDepartments = asyncHandler(async (req, res) => {
  res.json(await departmentService.listDepartments())
})

export const createDepartment = asyncHandler(async (req, res) => {
  res.status(201).json(await departmentService.createDepartment(req.body))
})

export const updateDepartment = asyncHandler(async (req, res) => {
  res.json(await departmentService.updateDepartment(req.params.id, req.body))
})
