import { prisma } from '../../config/prisma.js'
import { ApiError } from '../../utils/ApiError.js'
import { assertAdmin, EMPLOYEE_SELECT, PARTICIPANT_ROLES } from './access.js'
import { employeeCard } from './shape.js'

/**
 * Подсказка «Пополнить банк?»: в Иерархии появилась новая работа — значит,
 * пришёл клиент или новая задача по нему, и, возможно, пора пополнить банк
 * исполнителям. Владелец видит подсказку в «На проверке», пополняет банк
 * (форма откроется с клиентом и исполнителями) или отмахивается.
 *
 * Подсказка — не обязанность: работу мог создать руководитель, и решать,
 * давать ли деньги, всё равно владельцу.
 */

/** Положить подсказку о новой работе. Никогда не бросает: работа важнее. */
export async function createWorkHint(work) {
  try {
    const department = work.departmentId
      ? await prisma.department.findUnique({ where: { id: work.departmentId }, select: { name: true } })
      : null
    await prisma.motivationWorkHint.create({
      data: {
        workId: work.id,
        workTitle: work.title,
        clientId: work.client?.id ?? work.clientId ?? null,
        clientName: work.client?.name ?? null,
        departmentId: work.departmentId ?? null,
        departmentName: department?.name ?? null,
        assigneeIds: (work.assignees ?? []).map((a) => a.id),
        createdByName: work.createdBy?.name ?? null,
      },
    })
  } catch (e) {
    console.error('[motivation] подсказка о новой работе не записалась', work?.id, e)
  }
}

/** Ждущие подсказки — новые сверху: свежая работа важнее старой. */
export async function listHints(actor, now = new Date()) {
  assertAdmin(actor, 'Подсказки видит только владелец')
  let hints = await prisma.motivationWorkHint.findMany({ where: { status: 'pending' }, orderBy: { createdAt: 'desc' } })

  // Исполнителей берём нынешних: руководитель мог поменять их после
  // создания работы. Работу удалили — подсказка больше не нужна.
  const works = await prisma.work.findMany({
    where: { id: { in: hints.map((h) => h.workId) } },
    select: { id: true, title: true, assignees: { select: { id: true } } },
  })
  const workById = new Map(works.map((w) => [w.id, w]))
  const gone = hints.filter((h) => !workById.has(h.workId)).map((h) => h.id)
  if (gone.length) {
    await prisma.motivationWorkHint.updateMany({ where: { id: { in: gone } }, data: { status: 'dismissed', decidedAt: now } })
    hints = hints.filter((h) => workById.has(h.workId))
  }
  hints = hints.map((h) => ({ ...h, workTitle: workById.get(h.workId).title, assigneeIds: workById.get(h.workId).assignees.map((a) => a.id) }))

  const ids = [...new Set(hints.flatMap((h) => h.assigneeIds))]
  // Пополнить банк можно только тем, у кого он есть: сотрудникам и
  // руководителям, и только работающим.
  const people = ids.length
    ? await prisma.user.findMany({ where: { id: { in: ids }, role: { in: PARTICIPANT_ROLES }, active: true }, select: EMPLOYEE_SELECT })
    : []
  const byId = new Map(people.map((p) => [p.id, employeeCard(p)]))
  return hints.map((h) => ({
    id: h.id,
    work: { id: h.workId, title: h.workTitle },
    client: h.clientId ? { id: h.clientId, name: h.clientName } : null,
    department: h.departmentName,
    createdBy: h.createdByName,
    createdAt: h.createdAt,
    assignees: h.assigneeIds.map((id) => byId.get(id)).filter(Boolean),
  }))
}

async function decide(actor, id, status, now) {
  assertAdmin(actor, 'Подсказки закрывает только владелец')
  const res = await prisma.motivationWorkHint.updateMany({
    where: { id, status: 'pending' },
    data: { status, decidedById: actor.id, decidedAt: now },
  })
  if (res.count === 0 && !(await prisma.motivationWorkHint.findUnique({ where: { id }, select: { id: true } }))) {
    throw ApiError.notFound('Подсказка не найдена')
  }
  return { ok: true }
}

/** Банк пополнили — подсказка закрыта. */
export const markHintDone = (actor, id, now = new Date()) => decide(actor, id, 'done', now)

/** «Не нужно» — подсказка закрыта без пополнения. */
export const dismissHint = (actor, id, now = new Date()) => decide(actor, id, 'dismissed', now)

/** Сколько подсказок ждёт — для счётчика вкладки. */
export const pendingHints = () => prisma.motivationWorkHint.count({ where: { status: 'pending' } })
