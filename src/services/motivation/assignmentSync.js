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
 * Ручного назначения нет. Старые назначения на профили без отдела
 * закрываются при первой же синхронизации (она идёт при старте сервера),
 * людям подтягивается профиль их отдела и роли.
 */

export const audienceOf = (role) => (role === 'lead' ? 'lead' : 'staff')

/**
 * Какой профиль должен быть у человека. undefined — решать нечего, оставить
 * как есть; null — условий нет; иначе id профиля.
 *
 * Если у человека есть активный персональный профиль (personal: userId →
 * профиль), он и выбирается. Иначе профиль отдела и роли.
 *
 * Вручную профили не назначаются: любой текущий профиль, который не равен
 * профилю отдела и роли (старый профиль без отдела, профиль чужого отдела,
 * удалённый), закрывается. Нет отдела или профиля для него — условий нет.
 */
export function desiredProfileId(user, linked, current, personal = new Map()) {
  const has = Boolean(current?.profileId)
  // Персональный профиль главнее профиля отдела и роли.
  const mine = personal.get(user.id)
  if (mine) return mine.id
  if (!user.departmentId) return has ? null : undefined
  const own = linked.get(`${user.departmentId}:${audienceOf(user.role)}`)
  if (own) return own.id
  // Руководителю без своего профиля достаются условия специалистов.
  const staff = user.role === 'lead' ? linked.get(`${user.departmentId}:staff`) : null
  if (staff) return staff.id
  return has ? null : undefined
}

async function linkedProfiles(db) {
  const rows = await db.motivationProfile.findMany({
    where: { archivedAt: null, userId: null, departmentId: { not: null } },
    select: { id: true, departmentId: true, audience: true },
  })
  return new Map(rows.map((p) => [`${p.departmentId}:${p.audience}`, p]))
}

async function personalProfiles(db) {
  const rows = await db.motivationProfile.findMany({
    where: { archivedAt: null, userId: { not: null } },
    select: { id: true, userId: true },
  })
  return new Map(rows.map((p) => [p.userId, p]))
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
  const [linked, personal, current] = await Promise.all([linkedProfiles(db), personalProfiles(db), assignmentsAt(users.map((u) => u.id), now, db)])

  const changes = []
  for (const user of users) {
    const cur = current.get(user.id)
    const target = desiredProfileId(user, linked, cur, personal)
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
