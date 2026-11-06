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
// Короткие названия тоже сравниваем, но по границам слов и точно; совсем короткие (одна-две буквы) нет.
export const MIN_TITLE = 3
// Упоминание от этого числа букв считаем сокращением названия: «Десять постов» вместо длинного.
export const MIN_ABBREVIATION = 6

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

// Открытые задачи области смотрящего читаем одним запросом, не больше SCAN_MAX.
// Сколько мест с чужими задачами показываем и сколько задач читаем у адресатов.
export const SCAN_MAX = 5000
const PROBLEMS_MAX = 20
export const OWN_MAX = 2000
// Сколько дней сделанная задача адресата ещё может оправдать упоминание.
export const OWN_DONE_DAYS = 14
// Сделанные задачи старше этого для «всё уже сделано» и для отчёта не нужны:
// иначе у человека с длинной историей выборка упрётся в предел.
export const RECENT_DONE_DAYS = 30
const daysAgo = (days, now = new Date()) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
const OWNER = { select: { id: true, name: true, role: true, active: true, departmentId: true, department: { select: { name: true } } } }

/**
 * Все видимые задачи людей, любого статуса, одним запросом по ownerId. Названия
 * сравниваем уже в памяти: в запрос не попадает текст, который написала
 * модель. full: false значит, задач больше предела и мы видим не все.
 * since — сделанные раньше этой даты не берём (открытые берём всегда).
 */
async function ownTasks(ids, { since = null } = {}) {
  const rows = await prisma.task.findMany({
    where: { AND: [VISIBLE, { ownerId: { in: ids } }, since ? { OR: [{ status: { not: 'done' } }, { doneAt: { gte: since } }] } : {}] },
    orderBy: { updatedAt: 'desc' },
    take: OWN_MAX + 1,
    select: { id: true, title: true, status: true, deadline: true, origin: true, ownerId: true, work: { select: { title: true, client: { select: { name: true } } } } },
  })
  return { tasks: rows.slice(0, OWN_MAX), full: rows.length <= OWN_MAX }
}

/** Названия работ и клиентов задач человека: в кавычках они встречаются рядом с задачами, но это не задачи. */
const contextNames = (tasks) => tasks.flatMap((t) => [t.work?.title, t.work?.client?.name]).filter(Boolean)

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
 * Места, где адресату назвали чужую задачу. Одним запросом читаем открытые
 * видимые задачи адресатов и людей смотрящего (teamWhere и он сам), не больше
 * SCAN_MAX: вернулось ровно столько, значит, проверка неполная. Названия
 * сравниваем в памяти, нормализуя каждое один раз. Чужой считаем ту задачу,
 * чьё название целиком, по границам слов (и короткое тоже), есть в тексте, или
 * в чьё название входит упоминание в кавычках от шести букв. Своих задач
 * адресата это не касается: если у него есть такая же, длиннее или та, в
 * которую входит упоминание, ошибки нет. items — [{ userId, text }], viewer —
 * кто пишет поручение. Возвращает { problems: [{ userId, title, owners }], incomplete }.
 */
export async function foreignTitles(items, viewer) {
  const read = await prisma.task.findMany({
    where: { AND: [VISIBLE, { status: { in: ['today', 'progress'] } }, { owner: ownerScope(viewer, items.map((i) => i.userId)) }] },
    take: SCAN_MAX,
    select: { id: true, title: true, ownerId: true },
  })
  if (read.length >= SCAN_MAX) return { problems: [], incomplete: true }
  // Упоминания в кавычках от 6 букв — возможные сокращения; без повторов, не больше MENTIONS_MAX.
  const all = items.map((i) => quotedTitles(i.text).titles.map(squash).filter((m) => m.length >= MIN_ABBREVIATION))
  const needles = [...new Set(all.flat())].slice(0, MENTIONS_MAX)
  const prepared = items.map((item, i) => ({ userId: item.userId, said: padded(item.text), mentions: all[i].filter((m) => needles.includes(m)) }))
  const open = read.map((t) => {
    const low = squash(t.title)
    return { ...t, low, key: ` ${low} ` }
  })
  // Подозрение: чужая задача, чьё название целиком в тексте или содержит упоминание.
  // Одинаковые названия у нескольких исполнителей — одна запись.
  const suspects = new Map()
  for (const { userId, said, mentions } of prepared) {
    for (const t of open) {
      if (t.ownerId === userId) continue
      const exact = t.low.length >= MIN_TITLE && said.includes(t.key)
      const mention = exact ? null : mentions.find((m) => t.low.includes(m))
      if (!exact && !mention) continue
      const id = `${userId}|${t.key}`
      if (!suspects.has(id)) suspects.set(id, { userId, key: t.key, mention, title: t.title, ownerIds: new Set() })
      suspects.get(id).ownerIds.add(t.ownerId)
    }
  }
  // Свою задачу адресата подозревать нельзя: такая же или длиннее с этим названием
  // внутри, либо та, в которую входит упоминание. Сначала по прочитанным открытым.
  const excused = (s, titles) => titles.some((title) => padded(title).includes(s.key) || (s.mention && sameTitle(s.mention, title)))
  const mineOpen = (userId) => open.filter((t) => t.ownerId === userId).map((t) => t.title)
  let left = [...suspects.values()].filter((s) => !excused(s, mineOpen(s.userId)))
  if (!left.length) return { problems: [], incomplete: false }
  // Своё название могло быть у сделанной задачи: её среди открытых нет. Но
  // только у недавней: задача, закрытая месяц назад, не должна прикрывать
  // живую чужую с тем же названием.
  const since = new Date(Date.now() - OWN_DONE_DAYS * 24 * 60 * 60 * 1000)
  const own = await ownTasks([...new Set(left.map((s) => s.userId))], { since })
  if (!own.full) return { problems: [], incomplete: true }
  left = left.filter((s) => !excused(s, own.tasks.filter((t) => t.ownerId === s.userId).map((t) => t.title))).slice(0, PROBLEMS_MAX)
  // Имена владельцев нужны только для текста ошибки, и только у найденных.
  const ids = [...new Set(left.flatMap((s) => [...s.ownerIds]))]
  const users = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: OWNER.select }) : []
  const byId = new Map(users.map((u) => [u.id, u]))
  return { problems: left.map((s) => ({ userId: s.userId, title: s.title, owners: [...s.ownerIds].map((id) => byId.get(id)).filter(Boolean) })), incomplete: false }
}

/**
 * Можно ли не писать человеку: каждое названное в тексте упоминание
 * проверено и найдено сделанным. Читаем заново на момент отправки:
 * черновик лежит до трёх часов, за это время человек мог закрыть то, о чём
 * мы хотим спросить. Если упоминаний нет, часть отброшена или обрезана,
 * какое-то не нашлось среди его задач или хоть одна задача ещё открыта,
 * сообщение уходит как обычно.
 */
export async function allTitlesDone(userId, text, now = new Date()) {
  const { titles, truncated } = quotedTitles(text)
  if (!titles.length || truncated) return false
  const { tasks, full } = await ownTasks([userId], { since: daysAgo(RECENT_DONE_DAYS, now) })
  // Упёрлись в предел выборки — не уверены, что видим все задачи, пишем как есть.
  if (!full) return false
  // «Цепляющая главная» в кавычках рядом с задачей — это работа, а не задача:
  // такие упоминания пропускаем, но только если они не совпали ни с одной задачей.
  const context = new Set(contextNames(tasks).map(squash))
  let checked = 0
  for (const title of titles) {
    const found = tasks.filter((t) => sameTitle(title, t.title))
    if (!found.length) {
      if (context.has(squash(title))) continue
      return false
    }
    if (!found.every((t) => t.status === 'done')) return false
    checked += 1
  }
  return checked > 0
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
 * просрочена) и числа по всем его открытым задачам. Каждого читаем отдельно
 * и названия сверяем точно (после нормализации, без подстроки). Задач у
 * человека больше предела чтения — названные не показываем, только числа.
 * targets — [{ userId, text }].
 * Возвращает Map: userId → { named: [{ title, state }], counts, summary }.
 */
export async function taskStates(targets, now = new Date()) {
  const counts = await taskCounts(targets.map((t) => t.userId), now)
  const entries = await Promise.all(targets.map(async ({ userId, text }) => {
    const { tasks, full } = await ownTasks([userId], { since: daysAgo(RECENT_DONE_DAYS, now) })
    const mentions = quotedTitles(text).titles.map(squash)
    const mine = full ? tasks.filter((t) => t.ownerId === userId && mentions.includes(squash(t.title))) : []
    return [userId, {
      named: mine.slice(0, 5).map((t) => ({ title: t.title, state: [stateWord(t, now), ...(isOverdue(t, now) ? ['просрочена'] : [])].join(', ') })),
      counts: counts.get(userId),
      summary: countsSummary(counts.get(userId)),
    }]
  }))
  return new Map(entries)
}
