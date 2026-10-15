import { prisma } from '../config/prisma.js'
import { ApiError } from '../utils/ApiError.js'
import { syncAssignmentsSafe } from './motivation/assignmentSync.js'
import { archivedName, retireProfile } from './motivation/profiles.js'

const LEAD_SELECT = { id: true, name: true, email: true, avatarUrl: true, avatarColor: true, position: true }

/** Только живые отделы: удалённые в архиве из списков и выпадающих меню пропадают. */
export async function listDepartments() {
  return prisma.department.findMany({
    where: { archivedAt: null },
    orderBy: { createdAt: 'asc' },
    include: { lead: { select: LEAD_SELECT } },
  })
}

function nameTaken(e, name) {
  if (e?.code !== 'P2002') return
  const target = [].concat(e.meta?.target ?? [])
  if (target.includes('leadId')) throw ApiError.conflict('Этот человек уже руководит другим отделом')
  if (target.includes('name')) throw ApiError.conflict(`Отдел «${name}» уже есть`)
}

export async function createDepartment({ name, leadId, positions }) {
  try {
    return await prisma.department.create({
      data: { name, leadId: leadId || null, positions: positions || [] },
      include: { lead: { select: LEAD_SELECT } },
    })
  } catch (e) {
    nameTaken(e, name)
    throw e
  }
}

export async function updateDepartment(id, patch) {
  try {
    return await prisma.department.update({
      where: { id, archivedAt: null },
      data: patch,
      include: { lead: { select: LEAD_SELECT } },
    })
  } catch (e) {
    nameTaken(e, patch.name)
    throw ApiError.notFound('Отдел не найден')
  }
}

/**
 * Удалить можно любой отдел, в котором не осталось людей. Если у отдела
 * есть работы или услуги в Архиве, он не стирается, а уходит в архив: из
 * списков и меню пропадает, его работы и история остаются, а название
 * освобождается. Пустой отдел стирается совсем. Профили мотивации отдела в
 * обоих случаях уходят в архив вместе с историей баллов.
 */
export async function deleteDepartment(id) {
  const department = await prisma.department.findUnique({ where: { id }, select: { id: true, name: true, archivedAt: true } })
  if (!department || department.archivedAt) throw ApiError.notFound('Отдел не найден')

  const [memberCount, workCount, archiveCount] = await Promise.all([
    prisma.user.count({ where: { departmentId: id, active: true } }),
    prisma.work.count({ where: { departmentId: id } }),
    prisma.archiveService.count({ where: { departmentId: id } }),
  ])
  if (memberCount > 0) {
    throw ApiError.badRequest('В отделе ещё есть сотрудники — переведите их в другой отдел или увольте, прежде чем удалять отдел')
  }

  const now = new Date()
  await prisma.$transaction(async (tx) => {
    const profiles = await tx.motivationProfile.findMany({ where: { departmentId: id, archivedAt: null }, select: { id: true, title: true } })
    for (const p of profiles) await retireProfile(tx, p, now)
    if (workCount > 0 || archiveCount > 0) {
      await tx.department.update({
        where: { id },
        data: { archivedAt: now, leadId: null, name: await archivedName(tx, 'department', 'name', department.name, id, now) },
      })
    } else {
      await tx.department.delete({ where: { id } })
    }
  })
  await syncAssignmentsSafe()
}
