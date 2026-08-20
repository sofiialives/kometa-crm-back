import { prisma } from '../config/prisma.js'
import { ApiError } from '../utils/ApiError.js'

const OWNER_INCLUDE = { owner: { select: { id: true, name: true, avatarUrl: true } } }

export async function listTasksVisibleTo(user, { scope } = {}) {
  if (user.role === 'staff') {
    return prisma.task.findMany({ where: { ownerId: user.id }, orderBy: { deadline: 'asc' }, include: OWNER_INCLUDE })
  }
  if (user.role === 'lead') {
    return prisma.task.findMany({
      where: { departmentId: user.departmentId },
      orderBy: { deadline: 'asc' },
      include: OWNER_INCLUDE,
    })
  }

  if (scope === 'mine') {
    return prisma.task.findMany({ where: { ownerId: user.id }, orderBy: { deadline: 'asc' }, include: OWNER_INCLUDE })
  }
  if (scope === 'department') {
    return prisma.task.findMany({
      where: { departmentId: user.departmentId },
      orderBy: { deadline: 'asc' },
      include: OWNER_INCLUDE,
    })
  }
  return prisma.task.findMany({ orderBy: { deadline: 'asc' }, include: OWNER_INCLUDE })
}

/**
 * Каждый пишет задачи только себе — даже lead и admin. Видимость чужих
 * задач (весь отдел для lead, всё для admin) остаётся только для чтения.
 * departmentId у задачи может быть null — это нормально для личных
 * задач админа: у него самого нет отдела, и это не ошибка.
 */
export async function createTask({ title, description, deadline, workId, user }) {
  return prisma.task.create({
    data: {
      title,
      description: description || null,
      deadline,
      workId: workId || null,
      ownerId: user.id,
      departmentId: user.departmentId ?? null,
    },
    include: OWNER_INCLUDE,
  })
}

/**
 * Разрешено только менять статус (перетаскивание по колонкам).
 * Готово — финальный статус: обратно в работу вернуть нельзя, даже
 * прямым запросом к API в обход интерфейса.
 */
/**
 * Статус меняет только сам автор задачи. Admin и lead видят чужие
 * задачи (весь отдел / всё), но переставлять их по колонкам не могут —
 * каждый отвечает только за свою доску. Готово не финально: можно
 * перетащить обратно, если ошиблись.
 */
export async function updateTaskStatus(id, status, user) {
  const task = await prisma.task.findUnique({ where: { id } })
  if (!task) throw ApiError.notFound('Задача не найдена')

  if (task.ownerId !== user.id) {
    throw ApiError.forbidden('Менять статус можно только у своих задач')
  }

  return prisma.task.update({
    where: { id },
    data: { status, doneAt: status === 'done' ? new Date() : null },
    include: OWNER_INCLUDE,
  })
}

export function isOverdue(task) {
  return task.status !== 'done' && new Date(task.deadline).getTime() < Date.now()
}