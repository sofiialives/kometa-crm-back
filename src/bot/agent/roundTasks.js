import { prisma } from '../../config/prisma.js'
import { teamWhere } from '../ai/context.js'
import { VISIBLE } from './taskScope.js'

/**
 * Задачи в текстах поручений. Агент называет в сообщении человеку задачи, и
 * мы сверяем их с CRM, чтобы человеку не ушла чужая задача (Денису задача
 * Антона) и не ушёл вопрос про уже сделанное. Это страховка, а не гарантия:
 * короткие и общие названия мы не проверяем.
 */

// Кавычки любого вида: «ёлочки», "прямые", „лапки“, “английские”, 'одинарные'.
const QUOTED = /«([^«»\n]{2,200})»|"([^"\n]{2,200})"|„([^„“”\n]{2,200})[“”]|“([^“”\n]{2,200})”|'([^'\n]{2,200})'/g
const squash = (text) => String(text ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
// Слова целиком: пробелы по краям, чтобы «макет» не нашёлся внутри «макетирование».
const padded = (text) => ` ${squash(text)} `
// Название короче этого (после нормализации) слишком общее, чтобы назвать по нему чужую задачу.
export const MIN_TITLE = 8

/** Названия в кавычках из текста, без повторов. Это названия задач, а бывает и клиентов. */
export function quotedTitles(text) {
  const found = []
  for (const m of String(text ?? '').matchAll(QUOTED)) {
    const title = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5]).trim()
    if (title && !found.includes(title)) found.push(title)
  }
  return found
}

/**
 * Это название той задачи: те же слова с точностью до регистра, ё и знаков,
 * либо слова из текста — часть названия задачи (модель сократила, не короче
 * шести букв, чтобы «макет» не совпал со всем подряд). Для решения «уже
 * сделано»; чужой задачей по сокращению не называем.
 */
export function sameTitle(mention, title) {
  const a = squash(mention)
  const b = squash(title)
  return Boolean(a) && (a === b || (a.length >= 6 && b.includes(a)))
}

// Сколько открытых задач людей из области смотрящего читаем за раз для проверки.
const CANDIDATES_MAX = 3000
const OWNER = { select: { id: true, name: true, role: true, active: true, departmentId: true, department: { select: { name: true } } } }

/** Задачи из CRM (любого статуса, видимые), чьё название содержит названия из текстов. extra — отбор, например по владельцу. */
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
 * Места, где адресату назвали чужую задачу. Берём открытые задачи людей из
 * области смотрящего и ищем их названия целиком в тексте, с кавычками или
 * без: название совпало точно (до регистра, ё и знаков) и такой задачи нет
 * у самого адресата, а у него нет и более длинной с этим названием внутри,
 * которую назвали целиком. items — [{ userId, text }], viewer — кто пишет
 * поручение. Возвращает [{ userId, title, owners }].
 */
export async function foreignTitles(items, viewer) {
  const open = await prisma.task.findMany({
    where: { AND: [VISIBLE, { status: { in: ['today', 'progress'] } }, { owner: ownerScope(viewer, items.map((i) => i.userId)) }] },
    take: CANDIDATES_MAX,
    select: { id: true, title: true, ownerId: true, owner: OWNER },
  })
  // Одинаковые названия у нескольких исполнителей работы — одна запись с несколькими владельцами.
  const groups = new Map()
  for (const t of open) {
    const key = padded(t.title)
    if (key.trim().length < MIN_TITLE) continue
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(t)
  }
  const found = []
  for (const { userId, text } of items) {
    const said = padded(text)
    const mine = open.filter((t) => t.ownerId === userId).map((t) => padded(t.title))
    for (const [key, tasks] of groups) {
      if (!said.includes(key) || tasks.some((t) => t.ownerId === userId)) continue
      if (mine.some((u) => u.includes(key) && said.includes(u))) continue
      found.push({ userId, key, said, title: tasks[0].title, owners: [...new Map(tasks.map((t) => [t.owner.id, t.owner])).values()] })
    }
  }
  if (!found.length) return []
  // Своё название могло быть у сделанной задачи: её среди открытых нет.
  const own = await prisma.task.findMany({
    where: { AND: [VISIBLE, { ownerId: { in: [...new Set(found.map((f) => f.userId))] } }, { OR: found.map((f) => ({ title: { contains: f.title, mode: 'insensitive' } })) }] },
    take: CANDIDATES_MAX,
    select: { title: true, ownerId: true },
  })
  return found
    .filter((f) => !own.some((t) => t.ownerId === f.userId && padded(t.title).includes(f.key) && f.said.includes(padded(t.title))))
    .map(({ userId, title, owners }) => ({ userId, title, owners }))
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
