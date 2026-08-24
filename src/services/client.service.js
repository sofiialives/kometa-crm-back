import { prisma } from '../config/prisma.js'
import { ApiError } from '../utils/ApiError.js'

/**
 * Список видят все аутентифицированные — он нужен и админу (управление),
 * и lead (выбор клиента при создании работы в своём отделе). Порядок по
 * имени, а не по дате создания — так проще искать глазами в выпадающем
 * списке, когда клиентов много.
 */
export async function listClients() {
  return prisma.client.findMany({ orderBy: { name: 'asc' } })
}

export async function createClient(name) {
  try {
    return await prisma.client.create({ data: { name } })
  } catch (e) {
    if (e.code === 'P2002') throw ApiError.conflict('Клиент с таким именем уже есть')
    throw e
  }
}

export async function updateClient(id, name) {
  try {
    return await prisma.client.update({ where: { id }, data: { name } })
  } catch (e) {
    if (e.code === 'P2002') throw ApiError.conflict('Клиент с таким именем уже есть')
    if (e.code === 'P2025') throw ApiError.notFound('Клиент не найден')
    throw e
  }
}

/**
 * Удаление клиента сносит разом все его работы (во всех отделах) — их
 * задачи не теряются, а отвязываются, как и при удалении одной работы
 * напрямую из Иерархии.
 */
export async function deleteClient(id) {
  const client = await prisma.client.findUnique({ where: { id } })
  if (!client) throw ApiError.notFound('Клиент не найден')

  const works = await prisma.work.findMany({ where: { clientId: id } })
  const workIds = works.map((w) => w.id)

  if (workIds.length > 0) {
    await prisma.task.updateMany({ where: { workId: { in: workIds } }, data: { workId: null } })
    await prisma.work.deleteMany({ where: { id: { in: workIds } } })
  }

  await prisma.client.delete({ where: { id } })
  return { deletedWorks: workIds.length }
}
