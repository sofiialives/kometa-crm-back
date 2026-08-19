import { Department } from '../models/Department.js'
import { ApiError } from '../utils/ApiError.js'

export async function listDepartments() {
  return Department.find().populate('leadId', 'name email')
}

export async function createDepartment({ name, leadId }) {
  return Department.create({ name, leadId: leadId || null })
}

export async function updateDepartment(id, patch) {
  const dep = await Department.findByIdAndUpdate(id, patch, { new: true })
  if (!dep) throw ApiError.notFound('Отдел не найден')
  return dep
}
