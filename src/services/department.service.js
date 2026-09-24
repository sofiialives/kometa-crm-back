import { prisma } from '../config/prisma.js'
import { ApiError } from '../utils/ApiError.js'

const LEAD_SELECT = { id: true, name: true, email: true, avatarUrl: true, avatarColor: true, position: true }

export async function listDepartments() {
  return prisma.department.findMany({
    orderBy: { createdAt: 'asc' },
    include: { lead: { select: LEAD_SELECT } },
  })
}

export async function createDepartment({ name, leadId, positions }) {
  return prisma.department.create({
    data: { name, leadId: leadId || null, positions: positions || [] },
    include: { lead: { select: LEAD_SELECT } },
  })
}

export async function updateDepartment(id, patch) {
  try {
    return await prisma.department.update({
      where: { id },
      data: patch,
      include: { lead: { select: LEAD_SELECT } },
    })
  } catch {
    throw ApiError.notFound('Отдел не найден')
  }
}

export async function deleteDepartment(id) {
  const [memberCount, workCount, archiveCount] = await Promise.all([
    prisma.user.count({ where: { departmentId: id, active: true } }),
    prisma.work.count({ where: { departmentId: id } }),
    prisma.archiveService.count({ where: { departmentId: id } }),
  ])

  if (memberCount > 0) {
    throw ApiError.badRequest('В отделе ещё есть сотрудники — переведите их в другой отдел или увольте, прежде чем удалять отдел')
  }
  if (workCount > 0) {
    throw ApiError.badRequest('В отделе ещё есть работы — удалите или перенесите их, прежде чем удалять отдел')
  }
  // Без этой проверки удаление упало бы ошибкой внешнего ключа из базы:
  // услуги архива держат отдел так же, как работы.
  if (archiveCount > 0) {
    throw ApiError.badRequest('В Архиве есть услуги этого отдела — удалите их, прежде чем удалять отдел')
  }

  try {
    await prisma.department.delete({ where: { id } })
  } catch {
    throw ApiError.notFound('Отдел не найден')
  }
}