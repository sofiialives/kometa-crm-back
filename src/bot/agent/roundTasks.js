import { prisma } from '../../config/prisma.js'
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
async function tasksNamed(titles) {
  if (!titles.length) return []
  return prisma.task.findMany({
    where: { AND: [VISIBLE, { OR: titles.map((title) => ({ title: { contains: title, mode: 'insensitive' } })) }] },
    take: 300,
    select: { id: true, title: true, status: true, ownerId: true, owner: OWNER },
  })
}

/**
 * Места, где адресату назвали чужую задачу: название в ёлочках совпало с
 * открытой задачей другого человека и не совпало ни с одной задачей самого
 * адресата. items — [{ userId, text }]. Возвращает [{ userId, title, owners }].
 */
export async function foreignTitles(items) {
  const mentions = new Map(items.map((i) => [i.userId, quotedTitles(i.text)]))
  const tasks = await tasksNamed([...new Set([...mentions.values()].flat())])
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
