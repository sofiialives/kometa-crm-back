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

// Открытые задачи области смотрящего читаем страницами по PAGE_SIZE, не больше PAGES_MAX
// страниц, и держим в памяти только те, чьё название встретилось в текстах (не больше
// MATCHED_MAX). Сколько мест с чужими задачами показываем и сколько задач читаем у адресатов.
export const PAGE_SIZE = 1000
export const PAGES_MAX = 20
export const MATCHED_MAX = 300
const PROBLEMS_MAX = 20
export const OWN_MAX = 2000
const OWNER = { select: { id: true, name: true, role: true, active: true, departmentId: true, department: { select: { name: true } } } }

/**
 * Все видимые задачи людей, любого статуса, одним запросом по ownerId. Названия
 * сравниваем уже в памяти: в запрос не попадает текст, который написала
 * модель. full: false значит, задач больше предела и мы видим не все.
 */
async function ownTasks(ids) {
  const rows = await prisma.task.findMany({
    where: { AND: [VISIBLE, { ownerId: { in: ids } }] },
    orderBy: { updatedAt: 'desc' },
    take: OWN_MAX + 1,
    select: { id: true, title: true, status: true, deadline: true, origin: true, ownerId: true },
  })
  return { tasks: rows.slice(0, OWN_MAX), full: rows.length <= OWN_MAX }
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
 * Открытые задачи области смотрящего, чьё название целиком встречается хотя
 * бы в одном из текстов (saids, с пробелами по краям). Читаем страницами и
 * держим только совпавшие, так что большая область не мешает проверке.
 * null: не уложились в число страниц или совпавших слишком много, то есть
 * уже суженная выборка не поместилась и проверка неполная.
 */
async function scanOpen(viewer, ids, saids) {
  const where = { AND: [VISIBLE, { status: { in: ['today', 'progress'] } }, { owner: ownerScope(viewer, ids) }] }
  const hits = []
  let cursor = null
  for (let page = 0; page < PAGES_MAX; page += 1) {
    const rows = await prisma.task.findMany({
      where,
      orderBy: { id: 'asc' },
      take: PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, title: true, ownerId: true },
    })
    for (const row of rows) {
      const key = padded(row.title)
      if (key.trim().length >= MIN_TITLE && saids.some((said) => said.includes(key))) hits.push(row)
    }
    if (hits.length > MATCHED_MAX) return null
    if (rows.length < PAGE_SIZE) {
      if (!hits.length) return []
      const owners = await prisma.task.findMany({ where: { id: { in: hits.map((h) => h.id) } }, select: { id: true, owner: OWNER } })
      const ownerOf = new Map(owners.map((o) => [o.id, o.owner]))
      return hits.filter((h) => ownerOf.has(h.id)).map((h) => ({ ...h, owner: ownerOf.get(h.id) }))
    }
    cursor = rows.at(-1).id
  }
  return null
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
  const open = await scanOpen(viewer, items.map((i) => i.userId), items.map((i) => padded(i.text)))
  if (!open) return { problems: [], incomplete: true }
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
  const own = await ownTasks([...new Set(found.map((f) => f.userId))])
  if (!own.full) return { problems: [], incomplete: true }
  const problems = found
    .filter((f) => !own.tasks.some((t) => t.ownerId === f.userId && padded(t.title).includes(f.key) && f.said.includes(padded(t.title))))
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
  const { tasks, full } = await ownTasks([userId])
  // Упёрлись в предел выборки — не уверены, что видим все задачи, пишем как есть.
  if (!full) return false
  const mine = tasks
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
  const [counts, { tasks: named }] = await Promise.all([taskCounts(ids, now), ownTasks(ids)])
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
