import { Task } from '../models/Task.js'
import { ApiError } from '../utils/ApiError.js'

export async function listTasksVisibleTo(user, { scope } = {}) {
  if (user.role === 'staff') {
    return Task.find({ ownerId: user.id }).sort({ deadline: 1 })
  }

  if (user.role === 'lead') {
    return Task.find({ departmentId: user.departmentId }).sort({ deadline: 1 })
  }

  if (scope === 'mine') return Task.find({ ownerId: user.id }).sort({ deadline: 1 })
  if (scope === 'department') {
    return Task.find({ departmentId: user.departmentId }).sort({ deadline: 1 })
  }
  return Task.find().sort({ deadline: 1 })
}

export async function createTask({ title, deadline, workId, ownerId, user }) {
  const finalOwnerId = ownerId && user.role !== 'staff' ? ownerId : user.id
  return Task.create({
    title,
    deadline,
    workId: workId || null,
    ownerId: finalOwnerId,
    departmentId: user.departmentId,
  })
}

export async function updateTaskStatus(id, status, user) {
  const task = await Task.findById(id)
  if (!task) throw ApiError.notFound('Задача не найдена')

  const canEdit =
    user.role === 'admin' ||
    (user.role === 'lead' && String(task.departmentId) === user.departmentId) ||
    String(task.ownerId) === user.id

  if (!canEdit) throw ApiError.forbidden()

  task.status = status
  task.doneAt = status === 'done' ? new Date() : null
  await task.save()
  return task
}

export async function deleteTask(id, user) {
  const task = await Task.findById(id)
  if (!task) throw ApiError.notFound('Задача не найдена')
  const canDelete = user.role === 'admin' || String(task.ownerId) === user.id
  if (!canDelete) throw ApiError.forbidden()
  await task.deleteOne()
}

export function isOverdue(task) {
  return task.status !== 'done' && task.deadline.getTime() < Date.now()
}
