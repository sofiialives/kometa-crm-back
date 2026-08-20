import { prisma } from '../config/prisma.js'
import { ApiError } from '../utils/ApiError.js'

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

export async function listUsers({ departmentId } = {}) {
  return prisma.user.findMany({
    where: departmentId ? { departmentId } : {},
    orderBy: { createdAt: 'desc' },
    select: PUBLIC_USER_SELECT,
  })
}

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

export async function updateUser(id, patch) {
  const data = { ...patch }
  if (data.role === 'lead') data.position = 'Начальник отдела'

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