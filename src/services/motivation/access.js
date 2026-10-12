import { prisma } from '../../config/prisma.js'
import { ApiError } from '../../utils/ApiError.js'

/**
 * Кто кого видит и кому что можно во вкладке «Мотивация».
 *
 * Банк и баллы есть у сотрудников и у руководителей отделов: руководитель
 * получает премию по той же системе и следит за своими уровнями. Нет их
 * только у владельца (админа) — он начисляет другим, а себе незачем.
 *
 * Менять что-либо может только владелец: пополнять и списывать банк,
 * ставить и отменять баллы, отмечать покупку продукта, править настройки.
 * Руководитель свой отдел только видит — сколько премии у его людей и на
 * каком они уровне. Так решил заказчик, это строже, чем в первом задании.
 *
 * Каждая проверка делается на сервере, при каждом запросе. Скрытая кнопка
 * на фронте ничего не защищает: в задании прямо сказано, что чужой банк не
 * должен открываться ни на экране, ни прямой ссылкой, ни запросом.
 */

// Роли, у которых есть банк и баллы.
export const PARTICIPANT_ROLES = ['staff', 'lead']

export function isParticipant(user) {
  return PARTICIPANT_ROLES.includes(user?.role)
}

/** Кто открывает раздел «Команда»: владелец — всех, руководитель — свой отдел. */
export function isViewer(user) {
  return user?.role === 'admin' || user?.role === 'lead'
}

export function assertAdmin(user, message = 'Это может только владелец') {
  if (user?.role !== 'admin') throw ApiError.forbidden(message)
}

export function assertViewer(user) {
  if (!isViewer(user)) throw ApiError.forbidden('Раздел «Команда» доступен руководителю отдела и владельцу')
}

export function assertParticipant(user) {
  if (!isParticipant(user)) {
    throw ApiError.forbidden('У владельца нет своего банка: он начисляет сотрудникам и руководителям. Вам доступны «Команда» и «Настройки»')
  }
}

const EMPLOYEE_SELECT = {
  id: true,
  name: true,
  email: true,
  role: true,
  position: true,
  active: true,
  avatarUrl: true,
  avatarColor: true,
  departmentId: true,
  department: { select: { id: true, name: true } },
}

/** Участник мотивации по id. Владельца и несуществующих — нет. */
export async function loadEmployee(id) {
  const user = await prisma.user.findUnique({ where: { id }, select: EMPLOYEE_SELECT })
  if (!user || !isParticipant(user)) throw ApiError.notFound('Сотрудник не найден')
  return user
}

/**
 * Может ли actor управлять мотивацией target: пополнять и списывать банк,
 * ставить и отменять баллы. Только владелец, и только тем, у кого банк есть.
 */
export function canManage(actor, target) {
  return actor?.role === 'admin' && isParticipant(target)
}

export function assertCanManage(actor, target) {
  if (!canManage(actor, target)) throw ApiError.forbidden('Начислять и списывать может только владелец')
}

/**
 * Смотреть мотивацию target: свою — каждый, у кого она есть; владелец —
 * любую; руководитель — сотрудников своего отдела. Других руководителей
 * руководитель не видит, даже если они в том же отделе.
 */
export function canView(actor, target) {
  if (!actor || !isParticipant(target)) return false
  if (actor.id === target.id) return true
  if (actor.role === 'admin') return true
  if (actor.role === 'lead') {
    return Boolean(actor.departmentId) && target.role === 'staff' && target.departmentId === actor.departmentId
  }
  return false
}

export function assertCanView(actor, target) {
  // Тот же ответ, что и на несуществующего: по коду ответа нельзя даже
  // понять, есть ли такой человек.
  if (!canView(actor, target)) throw ApiError.notFound('Сотрудник не найден')
}

const MANAGE_DENIED = 'Среди выбранных есть люди, мотивацией которых вы не управляете'

/**
 * Загружает участников и проверяет, что actor может управлять каждым. Для
 * форм «пополнить банк» и «клиент купил продукт», где выбирают нескольких
 * сразу. Ошибка на одном отменяет всю операцию: частичное пополнение хуже,
 * чем понятный отказ.
 *
 * Ответ один на «нет такого», «у него нет банка» и «не ваше»: иначе по
 * разным текстам ошибки можно было бы перебором узнавать чужие роли.
 */
export async function loadManagedEmployees(actor, ids) {
  const unique = [...new Set(ids)]
  const users = await prisma.user.findMany({ where: { id: { in: unique } }, select: EMPLOYEE_SELECT })
  if (users.length !== unique.length || users.some((u) => !canManage(actor, u))) {
    throw ApiError.forbidden(MANAGE_DENIED)
  }
  for (const u of users) {
    if (!u.active) throw ApiError.badRequest(`${u.name || u.email}: сотрудник отключён`)
  }
  return users
}

export { EMPLOYEE_SELECT }
