import { prisma } from '../../config/prisma.js'
import { ApiError } from '../../utils/ApiError.js'

/**
 * Кто кого видит и кому что можно во вкладке «Мотивация».
 *
 * Банк и баллы есть только у рядовых сотрудников: у руководителей отделов и
 * у админа их нет, так решил заказчик. Руководитель ведёт свой отдел, админ
 * — всех. Сотрудник видит только себя.
 *
 * Каждая проверка делается на сервере, при каждом запросе. Скрытая кнопка
 * на фронте ничего не защищает: в задании прямо сказано, что чужой банк не
 * должен открываться ни на экране, ни прямой ссылкой, ни запросом.
 */

export const EMPLOYEE_ROLE = 'staff'

export function isEmployee(user) {
  return user?.role === EMPLOYEE_ROLE
}

export function isManager(user) {
  return user?.role === 'admin' || user?.role === 'lead'
}

export function assertAdmin(user) {
  if (user?.role !== 'admin') throw ApiError.forbidden('Настройки мотивации меняет только админ')
}

export function assertManager(user) {
  if (!isManager(user)) throw ApiError.forbidden('Это доступно руководителю отдела и админу')
}

export function assertEmployee(user) {
  if (!isEmployee(user)) {
    throw ApiError.forbidden('Банк и баллы есть только у сотрудников. Руководителю и админу доступен раздел «Команда»')
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

/** Сотрудник по id. Не сотрудник — значит, мотивации у него нет вовсе. */
export async function loadEmployee(id) {
  const user = await prisma.user.findUnique({ where: { id }, select: EMPLOYEE_SELECT })
  if (!user || !isEmployee(user)) throw ApiError.notFound('Сотрудник не найден')
  return user
}

/**
 * Может ли actor управлять мотивацией target: пополнять банк, ставить и
 * отменять баллы. Админ — любого сотрудника, руководитель — только своего
 * отдела.
 */
export function canManage(actor, target) {
  if (!target || !isEmployee(target)) return false
  if (actor.role === 'admin') return true
  if (actor.role === 'lead') return Boolean(actor.departmentId) && target.departmentId === actor.departmentId
  return false
}

export function assertCanManage(actor, target) {
  if (!canManage(actor, target)) {
    throw ApiError.forbidden('Можно управлять мотивацией только сотрудников своего отдела')
  }
}

/** Смотреть чужую мотивацию может тот, кто ею управляет. Свою — каждый. */
export function assertCanView(actor, target) {
  if (actor.id === target.id && isEmployee(actor)) return
  if (canManage(actor, target)) return
  // Тот же ответ, что и на несуществующего сотрудника: по коду ответа
  // нельзя было бы даже понять, есть ли такой человек.
  throw ApiError.notFound('Сотрудник не найден')
}

/**
 * Загружает сотрудников и проверяет, что actor может управлять каждым.
 * Для форм «пополнить банк» и «клиент купил продукт», где выбирают
 * нескольких сразу. Ошибка на одном отменяет всю операцию: частичное
 * пополнение хуже, чем понятный отказ.
 */
export async function loadManagedEmployees(actor, ids) {
  const unique = [...new Set(ids)]
  const users = await prisma.user.findMany({ where: { id: { in: unique } }, select: EMPLOYEE_SELECT })

  // Сначала — можно ли вообще управлять каждым, и ответ один на «нет такого»,
  // «не сотрудник» и «чужой отдел». Иначе по разным текстам ошибки
  // руководитель мог бы перебором узнать роль и статус людей из чужих
  // отделов. Подробности — только про тех, кем он и так управляет.
  if (users.length !== unique.length || users.some((u) => !canManage(actor, u))) {
    throw ApiError.forbidden(MANAGE_DENIED)
  }
  for (const u of users) {
    if (!u.active) throw ApiError.badRequest(`${u.name || u.email}: сотрудник отключён`)
  }
  return users
}

const MANAGE_DENIED = 'Среди выбранных есть люди, мотивацией которых вы не управляете'

/**
 * Отмена события из прошлого месяца меняет итоги, которые уже посчитаны и,
 * возможно, выплачены. По заданию задним числом баллы меняет только админ,
 * поэтому руководитель отменяет события только текущего месяца.
 */
export function assertCanCancelInMonth(actor, eventMonthKey, currentMonthKey) {
  if (actor.role === 'admin') return
  if (eventMonthKey !== currentMonthKey) {
    throw ApiError.forbidden('Этот месяц уже закрыт: отменить событие задним числом может только админ')
  }
}

export { EMPLOYEE_SELECT }
