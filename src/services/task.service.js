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
 * Обычно каждый пишет задачи только себе (доска «Задачи» так и делает —
 * ownerId с фронта не приходит вообще). Но в Иерархии главный отдела или
 * админ прикрепляют задачу конкретному исполнителю работы — для этого
 * ownerId можно передать явно, с проверками: staff назначать не может
 * вообще, lead — только своему отделу, admin — кому угодно.
 * departmentId у задачи в этом случае берётся от ОТДЕЛА ВЛАДЕЛЬЦА,
 * не от того, кто создаёт — иначе lead-фильтр видимости не найдёт
 * задачу у самого исполнителя.
 *
 * Задачи с workId (то есть созданные из Иерархии) пишут только lead
 * и admin — даже себе. Сотрудник добавляет себе задачи только через
 * личную доску «Задачи» (без workId), в Иерархии у него нет кнопки
 * создания вообще, и на уровне API это тоже запрещено, а не только
 * спрятано в интерфейсе.
 */
export async function createTask({ title, description, deadline, workId, ownerId, user }) {
  if (workId && user.role === 'staff') {
    throw ApiError.forbidden('Задачи по работам создаёт только главный отдела или админ')
  }
  if (workId && user.role === 'admin' && (!ownerId || ownerId === user.id)) {
    throw ApiError.badRequest('Админ не может назначить задачу по работе на себя — выберите сотрудника')
  }

  let finalOwnerId = user.id
  let departmentId = user.departmentId ?? null

  if (ownerId && ownerId !== user.id) {
    if (user.role === 'staff') {
      throw ApiError.forbidden('Сотрудник может создавать задачи только себе')
    }

    const owner = await prisma.user.findUnique({ where: { id: ownerId } })
    if (!owner || !owner.active) throw ApiError.badRequest('Сотрудник не найден')

    if (user.role === 'lead' && owner.departmentId !== user.departmentId) {
      throw ApiError.forbidden('Можно назначать задачи только сотрудникам своего отдела')
    }

    finalOwnerId = ownerId
    departmentId = owner.departmentId
  }

  return prisma.task.create({
    data: {
      title,
      description: description || null,
      deadline,
      workId: workId || null,
      ownerId: finalOwnerId,
      departmentId,
    },
    include: OWNER_INCLUDE,
  })
}

/**
 * Название и описание правят только те, кто управляет отделом задачи —
 * lead своего отдела или admin. Сам автор (staff) текст своей задачи
 * менять по-прежнему не может — это осталось только у руководителей,
 * и относится в первую очередь к задачам из Иерархии.
 */
export async function editTask(id, patch, user) {
  const task = await prisma.task.findUnique({ where: { id } })
  if (!task) throw ApiError.notFound('Задача не найдена')

  const canEdit = user.role === 'admin' || (user.role === 'lead' && task.departmentId === user.departmentId)
  if (!canEdit) throw ApiError.forbidden('Редактировать задачу может только главный отдела или админ')

  return prisma.task.update({
    where: { id },
    data: {
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.description !== undefined ? { description: patch.description || null } : {}),
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

/**
 * Продлить срок может сам автор (сам себе сдвинул время) или тот, кто
 * управляет его отделом: lead своего отдела, admin — любого.
 */
export async function extendDeadline(id, deadline, user) {
  const task = await prisma.task.findUnique({ where: { id } })
  if (!task) throw ApiError.notFound('Задача не найдена')

  const canExtend =
    task.ownerId === user.id ||
    user.role === 'admin' ||
    (user.role === 'lead' && task.departmentId === user.departmentId)
  if (!canExtend) throw ApiError.forbidden('Продлевать срок можно только своим задачам или задачам своего отдела')

  return prisma.task.update({ where: { id }, data: { deadline }, include: OWNER_INCLUDE })
}

/**
 * Удалять задачу может только тот, кто ей управляет как руководитель —
 * lead своего отдела или admin. Сам автор своей задачей это делать
 * по-прежнему не может (доска «Задачи» осталась неизменяемой для
 * рядового сотрудника), это отдельная возможность именно для Иерархии.
 */
export async function deleteTask(id, user) {
  const task = await prisma.task.findUnique({ where: { id } })
  if (!task) throw ApiError.notFound('Задача не найдена')

  const canDelete = user.role === 'admin' || (user.role === 'lead' && task.departmentId === user.departmentId)
  if (!canDelete) throw ApiError.forbidden('Удалять задачи может только главный отдела или админ')

  await prisma.task.delete({ where: { id } })
}