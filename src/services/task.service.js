import { prisma } from '../config/prisma.js'
import { ApiError } from '../utils/ApiError.js'

export async function listTasksVisibleTo(user, { scope } = {}) {
  if (user.role === 'staff') {
    return prisma.task.findMany({ where: { ownerId: user.id }, orderBy: { deadline: 'asc' } })
  }
  if (user.role === 'lead') {
    return prisma.task.findMany({ where: { departmentId: user.departmentId }, orderBy: { deadline: 'asc' } })
  }

  if (scope === 'mine') return prisma.task.findMany({ where: { ownerId: user.id }, orderBy: { deadline: 'asc' } })
  if (scope === 'department') {
    return prisma.task.findMany({ where: { departmentId: user.departmentId }, orderBy: { deadline: 'asc' } })
  }
  return prisma.task.findMany({ orderBy: { deadline: 'asc' } })
}

export async function createTask({ title, deadline, workId, ownerId, user }) {
  const finalOwnerId = ownerId && user.role !== 'staff' ? ownerId : user.id
  return prisma.task.create({
    data: { title, deadline, workId: workId || null, ownerId: finalOwnerId, departmentId: user.departmentId },
  })
}

export async function updateTaskStatus(id, status, user) {
  const task = await prisma.task.findUnique({ where: { id } })
  if (!task) throw ApiError.notFound('Задача не найдена')

  const canEdit =
    user.role === 'admin' ||
    (user.role === 'lead' && task.departmentId === user.departmentId) ||
    task.ownerId === user.id
  if (!canEdit) throw ApiError.forbidden()

  return prisma.task.update({
    where: { id },
    data: { status, doneAt: status === 'done' ? new Date() : null },
  })
}

export async function deleteTask(id, user) {
  const task = await prisma.task.findUnique({ where: { id } })
  if (!task) throw ApiError.notFound('Задача не найдена')
  const canDelete = user.role === 'admin' || task.ownerId === user.id
  if (!canDelete) throw ApiError.forbidden()
  await prisma.task.delete({ where: { id } })
}

export function isOverdue(task) {
  return task.status !== 'done' && new Date(task.deadline).getTime() < Date.now()
}
