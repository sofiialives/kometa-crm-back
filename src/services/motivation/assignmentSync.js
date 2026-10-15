import { prisma } from '../../config/prisma.js'
import { PARTICIPANT_ROLES } from './access.js'
import { assignmentsAt } from './profiles.js'

/**
 * Профиль человеку подбирается сам по его отделу и роли: профиль отдела
 * для руководителя или для специалиста. Руководителю без своего профиля
 * достаются условия специалистов его отдела.
 *
 * История не переписывается: при смене отдела, роли или профиля пишется
 * новое назначение с текущего момента, старые остаются, и прошлые баллы
 * считаются по тем условиям, что были тогда.
 *
 * Отделы, которым ещё не заведён ни один профиль, не трогаем: там люди
 * работают по профилю, назначенному вручную, как раньше. Это позволяет
 * переводить отделы на новые профили по одному.
 */

export const audienceOf = (role) => (role === 'lead' ? 'lead' : 'staff')

/**
 * Какой профиль должен быть у человека. undefined — решать нечего, оставить
 * как есть; null — условий нет; иначе id профиля.
 */
export function desiredProfileId(user, linked, current) {
  // Удалённый профиль или профиль чужого отдела (человека перевели) с
  // собой не уносим.
  const p = current?.profile
  const stale = Boolean(p && (p.archivedAt || (p.departmentId && p.departmentId !== user.departmentId)))
  if (!user.departmentId) return stale ? null : undefined
  const own = linked.get(`${user.departmentId}:${audienceOf(user.role)}`)
  if (own) return own.id
  const staff = user.role === 'lead' ? linked.get(`${user.departmentId}:staff`) : null
  if (staff) return staff.id
  // Для этой роли условия отделу ещё не заданы: живой ручной профиль
  // оставляем. Иначе условия руководителя, заведённые первыми, оставили бы
  // специалистов отдела совсем без баллов.
  return stale ? null : undefined
}

async function linkedProfiles(db) {
  const rows = await db.motivationProfile.findMany({
    where: { archivedAt: null, departmentId: { not: null } },
    select: { id: true, departmentId: true, audience: true },
  })
  return new Map(rows.map((p) => [`${p.departmentId}:${p.audience}`, p]))
}

// Один замок на все пересчёты назначений: два одновременных (правка
// профиля и старт сервера, двойной клик) не запишут одно и то же дважды.
export const lockAssignments = (tx) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('motivation-assignments'))`

/**
 * Привести назначения в порядок. userIds — только эти люди (после смены
 * роли или отдела), без него — все участники (после правки профилей).
 * Возвращает, сколько назначений поменялось.
 */
export function syncAssignments({ userIds = null, now = new Date() } = {}) {
  return prisma.$transaction(async (tx) => {
    await lockAssignments(tx)
    return syncInside(tx, userIds, now)
  })
}

async function syncInside(db, userIds, now) {
  const users = await db.user.findMany({
    where: { active: true, role: { in: PARTICIPANT_ROLES }, ...(userIds ? { id: { in: userIds } } : {}) },
    select: { id: true, role: true, departmentId: true },
  })
  if (users.length === 0) return 0
  const [linked, current] = await Promise.all([linkedProfiles(db), assignmentsAt(users.map((u) => u.id), now, db)])

  const changes = []
  for (const user of users) {
    const cur = current.get(user.id)
    const target = desiredProfileId(user, linked, cur)
    if (target === undefined) continue
    if ((cur?.profileId ?? null) === target) continue
    // Человека без единого назначения не записываем в «без условий»:
    // пустая строка в истории ничего бы не дала.
    if (!cur && target === null) continue
    changes.push({ userId: user.id, profileId: target, from: now })
  }
  if (changes.length) await db.motivationAssignment.createMany({ data: changes })
  return changes.length
}

/** То же, но без падения: сбой синхронизации не должен ломать сохранение. */
export async function syncAssignmentsSafe(options) {
  try {
    return await syncAssignments(options)
  } catch (e) {
    console.error('[мотивация] назначения профилей:', e.message)
    return 0
  }
}
