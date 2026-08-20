import { prisma } from '../config/prisma.js'
import { ApiError } from '../utils/ApiError.js'

export async function listDepartments() {
  return prisma.department.findMany({
    include: { lead: { select: { id: true, name: true, email: true } } },
  })
}

export async function createDepartment({ name, leadId, positions }) {
  return prisma.department.create({
    data: { name, leadId: leadId || null, positions: positions || [] },
  })
}

export async function updateDepartment(id, patch) {
  try {
    return await prisma.department.update({ where: { id }, data: patch })
  } catch {
    throw ApiError.notFound('Отдел не найден')
  }
}
