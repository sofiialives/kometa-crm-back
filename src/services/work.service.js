import { Work } from '../models/Work.js'
import { ApiError } from '../utils/ApiError.js'

export async function listWorksVisibleTo(user) {
  if (user.role === 'admin') return Work.find().populate('assignees', 'name').populate('createdBy', 'name')
  if (!user.departmentId) return []
  return Work.find({ departmentId: user.departmentId })
    .populate('assignees', 'name')
    .populate('createdBy', 'name')
}

export async function createWork({ clientName, title, departmentId, assignees, createdBy }) {
  return Work.create({ clientName, title, departmentId, assignees, createdBy })
}

export async function updateWork(id, patch, user) {
  const work = await Work.findById(id)
  if (!work) throw ApiError.notFound('Работа не найдена')
  if (user.role !== 'admin' && String(work.departmentId) !== user.departmentId) {
    throw ApiError.forbidden()
  }
  Object.assign(work, patch)
  await work.save()
  return work
}
