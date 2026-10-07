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

/**
 * Клиент с таким же именем, не глядя на регистр.
 *
 * Уникальность имени в базе регистрозависимая, то есть «Ozon» и «ozon» для
 * неё разные строки. Для человека это один и тот же клиент, и разъехавшись
 * на два, он потом разъезжается всюду: на доске, в архиве, в работах.
 * Поэтому сверяемся сами, а не полагаемся на базу.
 */
function findByName(name, exceptId) {
  return prisma.client.findFirst({
    where: {
      name: { equals: name, mode: 'insensitive' },
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
  })
}

export async function createClient(name) {
  const twin = await findByName(name)
  if (twin) throw ApiError.conflict(`Клиент «${twin.name}» уже есть`)

  try {
    return await prisma.client.create({ data: { name } })
  } catch (e) {
    // Гонка: одинаковое имя завели дважды одновременно.
    if (e.code === 'P2002') throw ApiError.conflict('Клиент с таким именем уже есть')
    throw e
  }
}

export async function updateClient(id, name) {
  const twin = await findByName(name, id)
  if (twin) throw ApiError.conflict(`Клиент «${twin.name}» уже есть`)

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
 *
 * А вот архив так не сносится. Если у клиента есть карточка в Архиве,
 * удаление отклоняется: одно нажатие здесь унесло бы всю накопленную по
 * нему историю отчётов — ровно то, ради чего архив и заводили. То же
 * запрещено и на уровне базы (внешний ключ RESTRICT), здесь — понятное
 * сообщение вместо ошибки Postgres.
 */
export async function deleteClient(id) {
  const client = await prisma.client.findUnique({ where: { id } })
  if (!client) throw ApiError.notFound('Клиент не найден')

  // Записей у клиента столько, сколько отделов его вели, — хватит любой.
  const inArchive = await prisma.archiveClient.findFirst({ where: { clientId: id } })
  if (inArchive) {
    throw ApiError.badRequest(
      'Клиент есть в Архиве — сначала уберите его оттуда, иначе пропадут все отчёты по нему',
    )
  }

  // То же и с Доской клиентов: там по нему ведётся финансовый учёт, и одно
  // нажатие здесь унесло бы всю выручку и расходы за все месяцы.
  const onBoard = await prisma.boardClient.findUnique({ where: { clientId: id } })
  if (onBoard) {
    throw ApiError.badRequest(
      'Клиент есть на Доске клиентов — сначала уберите его оттуда, иначе пропадёт весь учёт по нему',
    )
  }

  const works = await prisma.work.findMany({ where: { clientId: id } })
  const workIds = works.map((w) => w.id)

  if (workIds.length > 0) {
    await prisma.task.updateMany({ where: { workId: { in: workIds } }, data: { workId: null } })
    await prisma.work.deleteMany({ where: { id: { in: workIds } } })
  }

  await prisma.client.delete({ where: { id } })
  return { deletedWorks: workIds.length }
}
