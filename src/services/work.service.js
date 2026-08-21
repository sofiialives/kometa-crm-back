import { prisma } from '../config/prisma.js'
import { ApiError } from '../utils/ApiError.js'

const WORK_INCLUDE = {
  assignees: { select: { id: true, name: true, avatarUrl: true } },
  createdBy: { select: { id: true, name: true } },
}

export async function listWorksVisibleTo(user) {
  const where = user.role === 'admin' ? {} : user.departmentId ? { departmentId: user.departmentId } : { id: '__none__' }
  return prisma.work.findMany({ where, include: WORK_INCLUDE })
}

export async function createWork({ clientName, title, departmentId, assignees, createdBy }) {
  return prisma.work.create({
    data: {
      clientName,
      title,
      departmentId,
      createdById: createdBy,
      assignees: { connect: assignees.map((id) => ({ id })) },
    },
    include: WORK_INCLUDE,
  })
}

export async function updateWork(id, patch, user) {
  const work = await prisma.work.findUnique({ where: { id } })
  if (!work) throw ApiError.notFound('Работа не найдена')
  if (user.role !== 'admin' && work.departmentId !== user.departmentId) throw ApiError.forbidden()

  const { assignees, ...rest } = patch
  return prisma.work.update({
    where: { id },
    data: {
      ...rest,
      ...(assignees ? { assignees: { set: assignees.map((uid) => ({ id: uid })) } } : {}),
    },
    include: WORK_INCLUDE,
  })
}

/**
 * Задачи работы не удаляем вместе с ней — отвязываем (workId: null),
 * чтобы у сотрудника не пропадала история того, что он делал, даже
 * если саму работу закрыли или удалили по ошибке в названии клиента.
 */
export async function deleteWork(id, user) {
  const work = await prisma.work.findUnique({ where: { id } })
  if (!work) throw ApiError.notFound('Работа не найдена')
  if (user.role !== 'admin' && work.departmentId !== user.departmentId) throw ApiError.forbidden()

  await prisma.task.updateMany({ where: { workId: id }, data: { workId: null } })
  await prisma.work.delete({ where: { id } })
}
