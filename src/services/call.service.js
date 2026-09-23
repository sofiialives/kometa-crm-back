import { prisma } from '../config/prisma.js'
import { ApiError } from '../utils/ApiError.js'

const CALL_INCLUDE = {
  owner: { select: { id: true, name: true, avatarUrl: true, avatarColor: true } },
  department: { select: { id: true, name: true } },
}

const ORDER = { scheduledAt: 'asc' }

/**
 * Видимость повторяет Задачник: сотрудник видит свои звонки, главный
 * отдела — весь свой отдел. Отдельно стоит scope=all — вкладка «Все
 * звонки» у админа, где карточки потом группируются по отделам.
 *
 * owner.active — звонки уволенных не мозолят глаза в календаре отдела,
 * ровно как и их задачи.
 */
export async function listCallsVisibleTo(user, { scope } = {}) {
  if (scope === 'all') {
    if (user.role !== 'admin') throw ApiError.forbidden('Все звонки видит только админ')
    return prisma.call.findMany({
      where: { owner: { active: true } },
      orderBy: ORDER,
      include: CALL_INCLUDE,
    })
  }

  // departmentId у главного теоретически может быть пустым (его перевели,
  // отдел расформировали). Без этой проверки фильтр departmentId:null
  // выдал бы ему звонки админов — чужие и не его отдела.
  if (user.role === 'lead' && user.departmentId) {
    return prisma.call.findMany({
      where: { departmentId: user.departmentId, owner: { active: true } },
      orderBy: ORDER,
      include: CALL_INCLUDE,
    })
  }

  return prisma.call.findMany({
    where: { ownerId: user.id },
    orderBy: ORDER,
    include: CALL_INCLUDE,
  })
}

/**
 * Звонок всегда создаётся себе — по постановке «каждый ставит себе свои
 * звонки». Массива исполнителей, как у задач из Иерархии, здесь нет
 * сознательно: назначать звонки друг другу никто не просил.
 *
 * departmentId берём от автора и фиксируем в момент создания — по нему
 * главный видит свой отдел, а админ группирует «Все звонки». У админа
 * своего отдела нет, поэтому там останется null.
 */
export async function createCall({ title, note, scheduledAt, user }) {
  return prisma.call.create({
    data: {
      title,
      note: note || null,
      scheduledAt,
      ownerId: user.id,
      departmentId: user.departmentId || null,
    },
    include: CALL_INCLUDE,
  })
}

/**
 * В отличие от задач, где текст своей задачи сотрудник менять не может,
 * свой звонок он правит сам — и это главное, ради чего правка тут
 * появилась: звонок переносят, и время нужно поменять на лету, не дёргая
 * руководителя. Чужие звонки по-прежнему только у главного отдела и
 * админа.
 */
function assertCanManage(call, user) {
  const allowed =
    call.ownerId === user.id ||
    user.role === 'admin' ||
    (user.role === 'lead' && Boolean(call.departmentId) && call.departmentId === user.departmentId)
  if (!allowed) throw ApiError.forbidden('Звонок можно менять только свой или в своём отделе')
}

export async function editCall(id, patch, user) {
  const call = await prisma.call.findUnique({ where: { id } })
  if (!call) throw ApiError.notFound('Звонок не найден')
  assertCanManage(call, user)

  return prisma.call.update({
    where: { id },
    data: {
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.note !== undefined ? { note: patch.note || null } : {}),
      ...(patch.scheduledAt !== undefined ? { scheduledAt: patch.scheduledAt } : {}),
    },
    include: CALL_INCLUDE,
  })
}

export async function deleteCall(id, user) {
  const call = await prisma.call.findUnique({ where: { id } })
  if (!call) throw ApiError.notFound('Звонок не найден')
  assertCanManage(call, user)

  await prisma.call.delete({ where: { id } })
}
