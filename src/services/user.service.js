import { prisma } from '../config/prisma.js'
import { ApiError } from '../utils/ApiError.js'

/**
 * Наружу (списки, приглашение, обновление) никогда не отдаём
 * passwordHash / googleId / resetCodeHash / resetCodeExpires.
 */
const PUBLIC_USER_SELECT = {
  id: true,
  name: true,
  email: true,
  role: true,
  position: true,
  departmentId: true,
  status: true,
  active: true,
  avatarUrl: true,
  createdAt: true,
  updatedAt: true,
}

/**
 * lead всегда видит только свой отдел, даже если попробует передать
 * чужой departmentId в query — иначе он мог бы вытянуть список
 * сотрудников любого другого отдела компании через этот же эндпоинт.
 * admin может фильтровать по любому отделу или смотреть всех.
 */
/**
 * Уволенные (active: false) не возвращаются вообще — они должны
 * исчезать из CRM, а не просто помечаться бейджем. История их задач
 * не страдает: Task.owner подтягивается отдельным relation-запросом
 * прямо на самой задаче, а не через этот список.
 */
export async function listUsers({ departmentId } = {}, requestingUser) {
  const where = { active: true }
  if (requestingUser?.role === 'lead') {
    where.departmentId = requestingUser.departmentId
  } else if (departmentId) {
    where.departmentId = departmentId
  }

  return prisma.user.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    select: PUBLIC_USER_SELECT,
  })
}

/**
 * Приглашение: сначала должен существовать отдел (без него не
 * приглашаем вообще). Роль выбирается для этого отдела, а должность —
 * из списка должностей, которые в отделе уже завели заранее.
 * Для lead должность всегда «Начальник отдела» и не зависит от списка.
 */
export async function inviteUser({ email, role, position, departmentId }) {
  const exists = await prisma.user.findUnique({ where: { email } })
  if (exists) throw ApiError.conflict('Пользователь с таким email уже приглашён')

  const department = await prisma.department.findUnique({ where: { id: departmentId } })
  if (!department) throw ApiError.badRequest('Отдел не найден. Сначала создайте отдел')

  let finalPosition
  if (role === 'lead') {
    finalPosition = 'Начальник отдела'
  } else {
    if (!department.positions.length) {
      throw ApiError.badRequest('В этом отделе нет добавленных должностей')
    }
    if (!position) throw ApiError.badRequest('Укажите должность')
    if (!department.positions.includes(position)) {
      throw ApiError.badRequest('Такой должности нет в списке этого отдела')
    }
    finalPosition = position
  }

  const defaultName = email.trim().charAt(0).toUpperCase()

  return prisma.user.create({
    data: {
      email,
      role,
      position: finalPosition,
      name: defaultName,
      departmentId,
      status: 'invited',
    },
    select: PUBLIC_USER_SELECT,
  })
}

/**
 * При смене отдела/должности (перевод сотрудника через MoveUserModal)
 * должность обязана входить в список должностей ЦЕЛЕВОГО отдела —
 * та же проверка, что и при приглашении, иначе можно было бы сохранить
 * произвольную строку в обход списка должностей.
 */
export async function updateUser(id, patch) {
  const data = { ...patch }

  if (data.role === 'lead') {
    data.position = 'Начальник отдела'
  } else if (data.position !== undefined || data.departmentId !== undefined) {
    const current = await prisma.user.findUnique({ where: { id } })
    if (!current) throw ApiError.notFound('Пользователь не найден')

    const targetDepartmentId = data.departmentId !== undefined ? data.departmentId : current.departmentId
    const targetRole = data.role || current.role

    if (targetRole !== 'lead' && data.position) {
      if (!targetDepartmentId) throw ApiError.badRequest('Нельзя назначить должность без отдела')
      const department = await prisma.department.findUnique({ where: { id: targetDepartmentId } })
      if (!department) throw ApiError.badRequest('Отдел не найден')
      if (!department.positions.includes(data.position)) {
        throw ApiError.badRequest('Такой должности нет в списке этого отдела')
      }
    }
  }

  try {
    return await prisma.user.update({ where: { id }, data, select: PUBLIC_USER_SELECT })
  } catch {
    throw ApiError.notFound('Пользователь не найден')
  }
}

export async function deactivateUser(id, currentUserId) {
  if (id === currentUserId) {
    throw ApiError.badRequest('Нельзя уволить самого себя')
  }
  return updateUser(id, { active: false, departmentId: null, role: 'staff', position: null })
}
