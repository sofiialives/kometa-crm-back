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
