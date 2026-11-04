import { prisma } from '../../config/prisma.js'
import { teamWhere } from '../ai/context.js'
import { VISIBLE } from './taskScope.js'

/**
 * Задачи в текстах поручений. Агент называет в сообщении человеку задачи в
 * «ёлочках»: этих названий мы сверяем с CRM, чтобы человеку не ушла чужая
 * задача (Денису — задача Антона) и не ушёл вопрос про уже сделанное.
 */

const QUOTED = /«([^«»\n]{2,200})»/g
const squash = (text) => String(text ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

/** Названия в ёлочках из текста, без повторов. Это названия задач, а бывает и клиентов. */
export function quotedTitles(text) {
  const found = []
  for (const m of String(text ?? '').matchAll(QUOTED)) {
    const title = m[1].trim()
    if (title && !found.includes(title)) found.push(title)
  }
  return found
}

/**
 * Это название той задачи: те же слова с точностью до регистра, ё и знаков,
 * либо слова из текста — часть названия задачи (модель сократила, не короче
 * шести букв, чтобы «макет» не совпал со всем подряд).
 */
export function sameTitle(mention, title) {
  const a = squash(mention)
  const b = squash(title)
  return Boolean(a) && (a === b || (a.length >= 6 && b.includes(a)))
}

const OWNER = { select: { id: true, name: true, role: true, active: true, departmentId: true, department: { select: { name: true } } } }

/**
 * Задачи из CRM, чьё название содержит названия из текстов. Любого статуса
 * и любого владельца: дальше решают те, кому нужно (чья это задача, сделана ли).
 */
async function tasksNamed(titles, extra = {}) {
  if (!titles.length) return []
  return prisma.task.findMany({
    where: { AND: [VISIBLE, extra, { OR: titles.map((title) => ({ title: { contains: title, mode: 'insensitive' } })) }] },
    take: 300,
    select: { id: true, title: true, status: true, ownerId: true, owner: OWNER },
  })
}

/**
 * Чьи задачи вообще можно искать, когда поручение пишет viewer: адресаты,
 * его люди по teamWhere и он сам. Чужие задачи за пределами этого круга для
 * проверки не существуют, иначе ответ «это задача другого человека»
 * раскрыл бы, что такая задача есть у кого-то в чужом отделе.
 */
function ownerScope(viewer, addresseeIds) {
  return { OR: [teamWhere(viewer), { id: viewer.id }, { id: { in: addresseeIds } }] }
}

/**
 * Места, где адресату назвали чужую задачу: название в ёлочках совпало с
 * открытой задачей другого человека и не совпало ни с одной задачей самого
 * адресата. items — [{ userId, text }], viewer — кто пишет поручение.
 * Возвращает [{ userId, title, owners }].
 */
export async function foreignTitles(items, viewer) {
  const mentions = new Map(items.map((i) => [i.userId, quotedTitles(i.text)]))
  const tasks = await tasksNamed([...new Set([...mentions.values()].flat())], { owner: ownerScope(viewer, items.map((i) => i.userId)) })
  const problems = []
  for (const { userId } of items) {
    for (const title of mentions.get(userId)) {
      const named = tasks.filter((t) => sameTitle(title, t.title))
      if (!named.length || named.some((t) => t.ownerId === userId)) continue
      const open = named.filter((t) => t.status !== 'done')
      if (!open.length) continue
      const owners = [...new Map(open.map((t) => [t.owner.id, t.owner])).values()]
      problems.push({ userId, title, owners })
    }
  }
  return problems
}

/**
 * Все ли задачи, названные в тексте человеку, у него уже сделаны. Читаем
 * заново на момент отправки: черновик лежит до трёх часов, за это время
 * человек мог закрыть то, о чём мы хотим спросить. Названий нет или хоть
 * одна задача ещё открыта — нет.
 */
export async function allTitlesDone(userId, text) {
  const titles = quotedTitles(text)
  if (!titles.length) return false
  const mine = await tasksNamed(titles, { ownerId: userId })
  const named = titles.flatMap((title) => mine.filter((t) => sameTitle(title, t.title)))
  return named.length > 0 && named.every((t) => t.status === 'done')
}
