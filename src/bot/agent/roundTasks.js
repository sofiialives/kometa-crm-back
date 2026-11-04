import { prisma } from '../../config/prisma.js'
import { teamWhere } from '../ai/context.js'
import { isOverdue, stateWord, taskCounts, VISIBLE } from './taskScope.js'

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

// Сколько названий из одного текста проверяем и насколько короткое упоминание не берём.
export const MENTIONS_MAX = 20
export const MIN_MENTION = 4

/**
 * Названия в кавычках из текста, без повторов: { titles, truncated }. Это
 * названия задач, а бывает и клиентов. Слишком короткие отбрасываем сразу,
 * больше MENTIONS_MAX не берём: в запрос уходит ограниченное число.
 * truncated: что-то отброшено или обрезано, то есть список неполный, и
 * решать по нему «всё проверено» нельзя.
 */
export function quotedTitles(text) {
  const titles = []
  let truncated = false
  for (const m of String(text ?? '').matchAll(QUOTED)) {
    const title = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5]).trim()
    if (squash(title).length < MIN_MENTION) {
      truncated = true
      continue
    }
    if (titles.includes(title)) continue
    if (titles.length >= MENTIONS_MAX) {
      truncated = true
      break
    }
    titles.push(title)
  }
  return { titles, truncated }
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

// Сколько открытых задач людей из области смотрящего читаем за раз для проверки,
// сколько мест с чужими задачами показываем и сколько задач ищем по названиям.
export const CANDIDATES_MAX = 3000
const PROBLEMS_MAX = 20
const NAMED_MAX = 300
const OWNER = { select: { id: true, name: true, role: true, active: true, departmentId: true, department: { select: { name: true } } } }

/** Задачи из CRM (любого статуса, видимые), чьё название содержит названия из текстов. extra — отбор, например по владельцу. */
async function tasksNamed(titles, extra = {}) {
  if (!titles.length) return []
  return prisma.task.findMany({
    where: { AND: [VISIBLE, extra, { OR: titles.map((title) => ({ title: { contains: title, mode: 'insensitive' } })) }] },
    take: NAMED_MAX,
    select: { id: true, title: true, status: true, deadline: true, origin: true, ownerId: true, owner: OWNER },
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
 * поручение. Возвращает { problems: [{ userId, title, owners }], incomplete }.
 * incomplete: задач больше, чем мы читаем за раз, проверка неполная, и
 * молча пропускать её нельзя.
 */
export async function foreignTitles(items, viewer) {
  const read = await prisma.task.findMany({
    where: { AND: [VISIBLE, { status: { in: ['today', 'progress'] } }, { owner: ownerScope(viewer, items.map((i) => i.userId)) }] },
    take: CANDIDATES_MAX + 1,
    select: { id: true, title: true, ownerId: true, owner: OWNER },
  })
  if (read.length > CANDIDATES_MAX) return { problems: [], incomplete: true }
  const open = read
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
  if (!found.length) return { problems: [], incomplete: false }
  // Своё название могло быть у сделанной задачи: её среди открытых нет.
  const own = await prisma.task.findMany({
    where: { AND: [VISIBLE, { ownerId: { in: [...new Set(found.map((f) => f.userId))] } }, { OR: found.map((f) => ({ title: { contains: f.title, mode: 'insensitive' } })) }] },
    take: CANDIDATES_MAX + 1,
    select: { title: true, ownerId: true },
  })
  if (own.length > CANDIDATES_MAX) return { problems: [], incomplete: true }
  const problems = found
    .filter((f) => !own.some((t) => t.ownerId === f.userId && padded(t.title).includes(f.key) && f.said.includes(padded(t.title))))
    .map(({ userId, title, owners }) => ({ userId, title, owners }))
  return { problems: problems.slice(0, PROBLEMS_MAX), incomplete: false }
}

/**
 * Можно ли не писать человеку: каждое названное в тексте упоминание
 * проверено и найдено сделанным. Читаем заново на момент отправки:
 * черновик лежит до трёх часов, за это время человек мог закрыть то, о чём
 * мы хотим спросить. Если упоминаний нет, часть отброшена или обрезана,
 * какое-то не нашлось среди его задач или хоть одна задача ещё открыта,
 * сообщение уходит как обычно.
 */
export async function allTitlesDone(userId, text) {
  const { titles, truncated } = quotedTitles(text)
  if (!titles.length || truncated) return false
  const mine = await tasksNamed(titles, { ownerId: userId })
  // Упёрлись в предел выборки — не уверены, что видим все задачи, пишем как есть.
  if (mine.length >= NAMED_MAX) return false
  return titles.every((title) => {
    const found = mine.filter((t) => sameTitle(title, t.title))
    return found.length > 0 && found.every((t) => t.status === 'done')
  })
}

/** Числа открытых задач словами: личные и по Иерархии раздельно. */
export function countsSummary(counts) {
  const parts = []
  const names = { personal: 'личные', hierarchy: 'по Иерархии' }
  for (const kind of ['personal', 'hierarchy']) {
    const c = counts?.[kind]
    if (c?.open) parts.push(`${names[kind]} открыто ${c.open}, в процессе ${c.progress}, просрочено ${c.overdue}`)
  }
  return parts.join(', ') || 'открытых задач нет'
}

/**
 * Состояние задач адресатов на момент отчёта, а не на момент вопроса:
 * человек за это время мог всё сделать. Для каждого — задачи, названные в
 * отправленном ему тексте (с состоянием: сделана, в процессе, открыта,
 * просрочена) и числа по всем его открытым задачам. targets — [{ userId, text }].
 * Возвращает Map: userId → { named: [{ title, state }], counts, summary }.
 */
export async function taskStates(targets, now = new Date()) {
  const ids = [...new Set(targets.map((t) => t.userId))]
  const titles = [...new Set(targets.flatMap((t) => quotedTitles(t.text).titles))]
  const [counts, named] = await Promise.all([taskCounts(ids, now), tasksNamed(titles, { ownerId: { in: ids } })])
  return new Map(targets.map(({ userId, text }) => {
    const mentions = quotedTitles(text).titles
    const mine = named.filter((t) => t.ownerId === userId && mentions.some((m) => sameTitle(m, t.title)))
    return [userId, {
      named: mine.slice(0, 5).map((t) => ({ title: t.title, state: [stateWord(t, now), ...(isOverdue(t, now) ? ['просрочена'] : [])].join(', ') })),
      counts: counts.get(userId),
      summary: countsSummary(counts.get(userId)),
    }]
  }))
}
