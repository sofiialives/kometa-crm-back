import { prisma } from '../config/prisma.js'
import { ApiError } from '../utils/ApiError.js'

// departmentId у каждого человека нужен фронту: звонок относится сразу ко
// всем отделам, чьи люди в нём участвуют, и по вкладкам он раскладывается
// на месте, без отдельного запроса на каждое переключение.
const PERSON_SELECT = { id: true, name: true, avatarUrl: true, avatarColor: true, departmentId: true }

const CALL_INCLUDE = {
  owner: { select: PERSON_SELECT },
  participants: { select: PERSON_SELECT, orderBy: { name: 'asc' } },
  department: { select: { id: true, name: true } },
}

const ORDER = { scheduledAt: 'asc' }
const ACTIVE_OWNER = { owner: { active: true } }

function find(where) {
  return prisma.call.findMany({ where, orderBy: ORDER, include: CALL_INCLUDE })
}

/**
 * Звонок относится к отделу, если в нём есть хоть один человек оттуда —
 * организатор или любой из участников. Поэтому созвон дизайнера с
 * разработчиком виден и во вкладке «Дизайн», и во вкладке «Разработка»:
 * так и просили, чтобы ни один отдел не потерял свой звонок из виду.
 */
function inDepartment(departmentId) {
  return {
    OR: [
      { departmentId },
      { participants: { some: { departmentId } } },
    ],
  }
}

/** Звонки человека — и те, что он поставил сам, и те, куда его позвали. */
function forPerson(userId) {
  return {
    OR: [
      { ownerId: userId },
      { participants: { some: { id: userId } } },
    ],
  }
}

/**
 * Видимость повторяет Задачник: сотрудник видит свои звонки, главный
 * отдела — весь свой отдел. Сверх этого у админа есть вкладки отделов
 * (departmentId) и «Все звонки» (scope=all).
 *
 * owner.active — звонки уволенных не мозолят глаза в календаре отдела,
 * ровно как и их задачи. В личном списке этого фильтра нет: свои звонки
 * человек видит всегда.
 */
export async function listCallsVisibleTo(user, { scope, departmentId } = {}) {
  if (scope === 'all') {
    if (user.role !== 'admin') throw ApiError.forbidden('Все звонки видит только админ')
    return find(ACTIVE_OWNER)
  }

  if (departmentId) {
    if (user.role !== 'admin') throw ApiError.forbidden('Переключать отделы может только админ')
    return find({ ...inDepartment(departmentId), ...ACTIVE_OWNER })
  }

  // departmentId у главного теоретически может быть пустым (его перевели,
  // отдел расформировали). Без этой проверки фильтр departmentId:null
  // выдал бы ему звонки админов — чужие и не его отдела.
  if (user.role === 'lead' && user.departmentId) {
    return find({ ...inDepartment(user.departmentId), ...ACTIVE_OWNER })
  }

  return find(forPerson(user.id))
}

/**
 * Себя в участники не пишем: организатор и так в звонке, а второй раз он
 * бы задвоился в списке аватаров. Уволенных не зовём — их звонки и так
 * скрыты из отдела, и приглашение никуда не дошло бы.
 */
async function normalizeParticipants(participantIds, ownerId) {
  const ids = [...new Set(participantIds || [])].filter((id) => id && id !== ownerId)
  if (ids.length === 0) return []

  const found = await prisma.user.count({ where: { id: { in: ids }, active: true } })
  if (found !== ids.length) {
    throw ApiError.badRequest('Кого-то из участников больше нет среди сотрудников')
  }
  return ids
}

/**
 * Звонок всегда создаётся себе — по постановке «каждый ставит себе свои
 * звонки». Позвать при этом можно кого угодно из любого отдела: созвон с
 * клиентом по разработке нередко требует ещё и дизайнера.
 *
 * departmentId берём от организатора и фиксируем в момент создания. Отделы
 * участников отдельно не храним — они читаются из самих участников, и
 * перевод человека в другой отдел не оставляет в звонке устаревшую запись.
 */
export async function createCall({ title, note, scheduledAt, participantIds, user }) {
  const ids = await normalizeParticipants(participantIds, user.id)

  return prisma.call.create({
    data: {
      title,
      note: note || null,
      scheduledAt,
      ownerId: user.id,
      departmentId: user.departmentId || null,
      ...(ids.length ? { participants: { connect: ids.map((id) => ({ id })) } } : {}),
    },
    include: CALL_INCLUDE,
  })
}

/**
 * Менять звонок может только организатор — он в контакте с клиентом и
 * знает, переносится ли созвон. Участник карточку видит, но не трогает:
 * иначе двое начнут двигать время, и никто не поймёт, когда звонок.
 *
 * Это сознательно строже, чем у задач, где правит ещё и главный отдела.
 */
function assertOrganizer(call, user) {
  if (call.ownerId !== user.id) {
    throw ApiError.forbidden('Менять звонок может только тот, кто его поставил')
  }
}

export async function editCall(id, patch, user) {
  const call = await prisma.call.findUnique({ where: { id } })
  if (!call) throw ApiError.notFound('Звонок не найден')
  assertOrganizer(call, user)

  const ids = patch.participantIds === undefined
    ? null
    : await normalizeParticipants(patch.participantIds, call.ownerId)

  return prisma.call.update({
    where: { id },
    data: {
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.note !== undefined ? { note: patch.note || null } : {}),
      ...(patch.scheduledAt !== undefined ? { scheduledAt: patch.scheduledAt } : {}),
      // set, а не connect: список участников заменяется целиком, иначе
      // снятых с звонка людей нельзя было бы убрать.
      ...(ids ? { participants: { set: ids.map((pid) => ({ id: pid })) } } : {}),
    },
    include: CALL_INCLUDE,
  })
}

export async function deleteCall(id, user) {
  const call = await prisma.call.findUnique({ where: { id } })
  if (!call) throw ApiError.notFound('Звонок не найден')
  assertOrganizer(call, user)

  await prisma.call.delete({ where: { id } })
}
