import { prisma } from '../../config/prisma.js'
import { ApiError } from '../../utils/ApiError.js'
import { assertViewer, PARTICIPANT_ROLES } from './access.js'
import { monthRange } from './month.js'

/**
 * История баллов для раздела «История»: кому, сколько, за что и когда.
 * У каждой записи видно, как она появилась: сама по правилу, вручную
 * владельцем или по его решению на заявку. Отменённые остаются в истории с
 * тем, кто отменил и почему.
 *
 * Владелец видит всех, руководитель — специалистов своего отдела. Фильтры:
 * месяц или всё время, отдел, человек. По 100 записей, свежие сверху;
 * before — время последней показанной, чтобы догрузить следующие.
 */

const PAGE = 100
const PERSON = { select: { id: true, name: true } }

export function sourceOf(event) {
  if (event.review) return 'review'
  if (event.mode === 'auto' && !event.createdById) return 'auto'
  return 'manual'
}

function card(e) {
  return {
    id: e.id,
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

export async function getHistory(actor, { month = 'all', departmentId = null, userId = null, before = null } = {}) {
  assertViewer(actor)
  // Руководитель видит только специалистов своего отдела, как и в «Команде».
  const people = actor.role === 'lead'
    ? { role: 'staff', departmentId: actor.departmentId ?? '__none__' }
    : { role: { in: PARTICIPANT_ROLES }, ...(departmentId ? { departmentId } : {}) }

  const where = { user: people }
  if (userId) where.userId = userId
  const occurredAt = {}
  if (month !== 'all') {
    const { start, end } = monthRange(month)
    occurredAt.gte = start
    occurredAt.lt = end
  }
  if (before) {
    const at = new Date(before)
    if (Number.isNaN(at.getTime())) throw ApiError.badRequest('Неверная дата')
    occurredAt.lt = occurredAt.lt && occurredAt.lt < at ? occurredAt.lt : at
  }
  if (Object.keys(occurredAt).length) where.occurredAt = occurredAt

  const rows = await prisma.motivationEvent.findMany({
    where,
    orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }],
    take: PAGE + 1,
    include: {
      user: { select: { id: true, name: true, department: { select: { name: true } } } },
      createdBy: PERSON,
      cancelledBy: PERSON,
      review: { select: { id: true, decidedBy: PERSON } },
    },
  })
  const items = rows.slice(0, PAGE).map(card)
  return { items, more: rows.length > PAGE, next: rows.length > PAGE ? items.at(-1).at : null }
}
