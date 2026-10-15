import { prisma } from '../../config/prisma.js'
import { ApiError } from '../../utils/ApiError.js'
import { assertViewer, PARTICIPANT_ROLES } from './access.js'
import { monthRange } from './month.js'

/**
 * История баллов для раздела «История»: кому, сколько, за что и когда.
 * У каждой записи видно, как она появилась: сама по правилу, вручную
 * владельцем или по его решению на заявку. Отменённые остаются в истории с
 * тем, кто отменил и почему. Заявки, по которым владелец решил «не
 * начислять» или которые сняла система, тоже здесь — с нулём баллов.
 *
 * Владелец видит всех, руководитель — специалистов своего отдела. Фильтры:
 * месяц или всё время, отдел, человек. По 100 записей, свежие сверху;
 * before — курсор последней показанной («время|id»), чтобы догрузить
 * следующие: у ночных штрафов время одно на всех, одного времени мало.
 */

const PAGE = 100
const PERSON = { select: { id: true, name: true } }
const USER = { select: { id: true, name: true, department: { select: { name: true } } } }

export function sourceOf(event) {
  if (event.review) return 'review'
  if (event.mode === 'auto' && !event.createdById) return 'auto'
  return 'manual'
}

export function encodeCursor(item) {
  return `${new Date(item.at).toISOString()}|${item.id}`
}

export function decodeCursor(before) {
  if (!before) return null
  const [iso, id] = String(before).split('|')
  const at = new Date(iso)
  if (Number.isNaN(at.getTime()) || !id) throw ApiError.badRequest('Неверная отметка для догрузки')
  return { at, id }
}

/** Строго раньше курсора в порядке «время, потом id» по убыванию. */
function beforeCursor(field, cursor) {
  if (!cursor) return {}
  return { OR: [{ [field]: { lt: cursor.at } }, { [field]: cursor.at, id: { lt: cursor.id } }] }
}

function eventCard(e) {
  return {
    id: e.id,
    kind: 'event',
    at: e.occurredAt,
    user: { id: e.user.id, name: e.user.name, department: e.user.department?.name ?? null },
    title: e.title,
    prizePoints: e.prizePoints,
    levelPoints: e.levelPoints,
    taskTitle: e.taskTitle,
    clientName: e.clientName,
    comment: e.comment,
    source: sourceOf(e),
    by: e.review?.decidedBy?.name ?? e.createdBy?.name ?? null,
    cancelled: e.cancelledAt ? { at: e.cancelledAt, by: e.cancelledBy?.name ?? null, reason: e.cancelReason } : null,
  }
}

function reviewCard(r) {
  return {
    id: r.id,
    kind: 'review',
    at: r.decidedAt ?? r.updatedAt,
    user: { id: r.user.id, name: r.user.name, department: r.user.department?.name ?? null },
    title: r.title,
    prizePoints: 0,
    levelPoints: 0,
    suggestedPoints: r.prizePoints,
    taskTitle: r.taskTitle,
    clientName: null,
    comment: r.decisionNote,
    source: r.status === 'rejected' ? 'rejected' : 'withdrawn',
    by: r.decidedBy?.name ?? null,
    cancelled: null,
  }
}

export async function getHistory(actor, { month = 'all', departmentId = null, userId = null, before = null } = {}) {
  assertViewer(actor)
  // Руководитель видит только специалистов своего отдела, как и в «Команде».
  const people = actor.role === 'lead'
    ? { role: 'staff', departmentId: actor.departmentId ?? '__none__' }
    : { role: { in: PARTICIPANT_ROLES }, ...(departmentId ? { departmentId } : {}) }
  const cursor = decodeCursor(before)
  const range = month === 'all' ? null : monthRange(month)
  const within = (field) => (range ? { [field]: { gte: range.start, lt: range.end } } : {})
  const who = { user: people, ...(userId ? { userId } : {}) }

  const [events, reviews] = await Promise.all([
    prisma.motivationEvent.findMany({
      where: { AND: [who, within('occurredAt'), beforeCursor('occurredAt', cursor)] },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: PAGE + 1,
      include: { user: USER, createdBy: PERSON, cancelledBy: PERSON, review: { select: { id: true, decidedBy: PERSON } } },
    }),
    // Решения «не начислять» и снятые системой заявки: начисленные уже
    // есть в журнале событием. Время — когда решили.
    prisma.motivationReview.findMany({
      where: { AND: [who, { status: { in: ['rejected', 'withdrawn'] }, decidedAt: { not: null } }, within('decidedAt'), beforeCursor('decidedAt', cursor)] },
      orderBy: [{ decidedAt: 'desc' }, { id: 'desc' }],
      take: PAGE + 1,
      include: { user: USER, decidedBy: PERSON },
    }),
  ])

  const merged = [...events.map(eventCard), ...reviews.map(reviewCard)]
    .sort((a, b) => new Date(b.at) - new Date(a.at) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
  const items = merged.slice(0, PAGE)
  const more = merged.length > PAGE
  return { items, more, next: more ? encodeCursor(items.at(-1)) : null }
}
