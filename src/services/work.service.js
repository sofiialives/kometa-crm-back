import { prisma } from '../config/prisma.js'
import { ApiError } from '../utils/ApiError.js'

const WORK_INCLUDE = {
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

export async function deleteWork(id, user) {
  const work = await prisma.work.findUnique({ where: { id } })
  if (!work) throw ApiError.notFound('Работа не найдена')
  if (user.role !== 'admin' && work.departmentId !== user.departmentId) throw ApiError.forbidden()

  await prisma.task.updateMany({ where: { workId: id }, data: { workId: null } })
  await prisma.work.delete({ where: { id } })
}

/**
 * Клиент как отдельная сущность в базе не хранится — это просто
 * повторяющееся clientName внутри Work. «Удалить клиента» значит удалить
 * все его работы разом (тем же способом, что deleteWork — задачи не
 * удаляются, а отвязываются). Доступно только админу, не lead: клиент
 * может иметь работы в разных отделах одновременно.
 */
export async function deleteClient(clientName, user) {
  if (user.role !== 'admin') throw ApiError.forbidden('Удалять клиентов может только админ')

  const works = await prisma.work.findMany({ where: { clientName } })
  if (works.length === 0) throw ApiError.notFound('Клиент не найден')

  const workIds = works.map((w) => w.id)
  await prisma.task.updateMany({ where: { workId: { in: workIds } }, data: { workId: null } })
  await prisma.work.deleteMany({ where: { id: { in: workIds } } })

  return { deletedWorks: workIds.length }
}