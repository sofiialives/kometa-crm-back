import bcrypt from 'bcryptjs'
import { User } from '../models/User.js'
import { ApiError } from '../utils/ApiError.js'

export async function listUsers({ departmentId } = {}) {
  const filter = departmentId ? { departmentId } : {}
  return User.find(filter).sort({ createdAt: -1 })
}

export async function createUser({ name, email, password, role, departmentId }) {
  const exists = await User.findOne({ email })
  if (exists) throw ApiError.conflict('Пользователь с таким email уже есть')

  const passwordHash = await bcrypt.hash(password, 10)
  return User.create({ name, email, passwordHash, role, departmentId: departmentId || null })
}

export async function updateUser(id, patch) {
  const user = await User.findByIdAndUpdate(id, patch, { new: true })
  if (!user) throw ApiError.notFound('Пользователь не найден')
  return user
}

export async function deactivateUser(id) {
  return updateUser(id, { active: false, departmentId: null, role: 'staff' })
}
