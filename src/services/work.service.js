import { prisma } from '../config/prisma.js'
import { ApiError } from '../utils/ApiError.js'

const WORK_INCLUDE = {
  client: { select: { id: true, name: true } },
  assignees: { select: { id: true, name: true, avatarUrl: true, avatarColor: true } },
  createdBy: { select: { id: true, name: true } },
}

/**
 * lead и admin видят весь отдел (или всё, для admin), рядовой сотрудник —
 * только те работы, где сам в исполнителях или у него там есть задача.
 * Без этого staff мог получить полный список работ отдела прямо
 * в ответе API, даже если интерфейс этого не показывал.
 */
export async function listWorksVisibleTo(user) {
  if (user.role === 'admin') {
    return prisma.work.findMany({ include: WORK_INCLUDE })
  }
  if (!user.departmentId) return []

  if (user.role === 'lead') {
    return prisma.work.findMany({ where: { departmentId: user.departmentId }, include: WORK_INCLUDE })
  }

  return prisma.work.findMany({
    where: {
      departmentId: user.departmentId,
      OR: [{ assignees: { some: { id: user.id } } }, { tasks: { some: { ownerId: user.id } } }],
    },
    include: WORK_INCLUDE,
  })
}

export async function createWork({ clientId, title, departmentId, assignees, createdBy }) {
  const client = await prisma.client.findUnique({ where: { id: clientId } })
  if (!client) throw ApiError.badRequest('Клиент не найден — выберите из списка')

  return prisma.work.create({
    data: {
      clientId,
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

  if (patch.clientId) {
    const client = await prisma.client.findUnique({ where: { id: patch.clientId } })
    if (!client) throw ApiError.badRequest('Клиент не найден — выберите из списка')
  }

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

export async function deleteWork(id, user) {
  const work = await prisma.work.findUnique({ where: { id } })
  if (!work) throw ApiError.notFound('Работа не найдена')
  if (user.role !== 'admin' && work.departmentId !== user.departmentId) throw ApiError.forbidden()

  await prisma.task.updateMany({ where: { workId: id }, data: { workId: null } })
  await prisma.work.delete({ where: { id } })
}
