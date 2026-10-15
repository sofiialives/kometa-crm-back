import { prisma } from '../../config/prisma.js'

/**
 * Откуда брать условия: профиль сотрудника на нужный момент, шкала премии
 * (своя у профиля или общая), уровни работы с подсказками профиля и общие
 * настройки.
 */

export const PROFILE_INCLUDE = {
  eventTypes: { orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] },
  prizeLevels: { orderBy: { position: 'asc' } },
}

/** Настройки по умолчанию — те же, что в миграции. На случай пустой базы. */
export const DEFAULT_SETTINGS = {
  id: 'global',
  overduePenaltyCap: 10,
  personalTaskDailyCap: 2,
  notifyBank: true,
  notifyPoints: true,
  autoTasksFrom: null,
  checkinFrom: null,
  overdueCheckedUntil: null,
  taskPointsMode: 'review',
  personalTaskDailyLimit: 7,
}

export async function getSettingsRow(db = prisma) {
  const row = await db.motivationSettings.findUnique({ where: { id: 'global' } })
  return row ?? { ...DEFAULT_SETTINGS, updatedAt: null }
}

export async function getGlobalScale(db = prisma) {
  return db.motivationPrizeLevel.findMany({ where: { profileId: null }, orderBy: { position: 'asc' } })
}

export async function getWorkLevels(db = prisma) {
  return db.motivationWorkLevel.findMany({ orderBy: { position: 'asc' } })
}

/** «Дизайн (удалён 16.10.2026)», а при совпадении ещё и хвост id. */
export async function archivedName(db, model, field, value, id, now = new Date()) {
  const day = now.toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' })
  const name = `${value} (удалён ${day})`
  const clash = await db[model].findFirst({ where: { [field]: name, id: { not: id } }, select: { id: true } })
  return clash ? `${name} ${id.slice(-4)}` : name
}

/**
 * Убрать профиль. Если по нему ещё никто не работал, он стирается совсем.
 * Если работали, уходит в архив: прошлые баллы остаются в истории с его
 * названием, людям он больше не назначается, а название освобождается.
 */
export async function retireProfile(db, profile, now = new Date()) {
  const [assigned, events] = await Promise.all([
    db.motivationAssignment.count({ where: { profileId: profile.id } }),
    db.motivationEvent.count({ where: { profileId: profile.id } }),
  ])
  if (!assigned && !events) {
    await db.motivationProfile.delete({ where: { id: profile.id } })
    return 'deleted'
  }
  const title = await archivedName(db, 'motivationProfile', 'title', profile.title, profile.id, now)
  await db.motivationProfile.update({ where: { id: profile.id }, data: { archivedAt: now, title } })
  return 'archived'
}

/**
 * Профиль сотрудника на момент at: последнее назначение, сделанное не
 * позже. Возвращает и само назначение — по его дате решается, полагается
 * ли человеку стартовая сумма банка в этом месяце.
 */
export async function assignmentAt(userId, at = new Date(), db = prisma) {
  return db.motivationAssignment.findFirst({
    where: { userId, from: { lte: at } },
    orderBy: [{ from: 'desc' }, { createdAt: 'desc' }],
    include: { profile: { include: PROFILE_INCLUDE } },
  })
}

/**
 * То же для многих сотрудников разом — для таблицы команды. Один запрос
 * вместо запроса на каждого: в отделе может быть два десятка человек.
 */
export async function assignmentsAt(userIds, at = new Date(), db = prisma) {
  if (userIds.length === 0) return new Map()
  // distinct по сотруднику вместе с сортировкой «новые сверху» оставляет
  // ровно одно, последнее назначение на человека. Вся история переводов с
  // профилями целиком здесь не нужна.
  const rows = await db.motivationAssignment.findMany({
    where: { userId: { in: userIds }, from: { lte: at } },
    orderBy: [{ userId: 'asc' }, { from: 'desc' }, { createdAt: 'desc' }],
    distinct: ['userId'],
    include: { profile: { include: PROFILE_INCLUDE } },
  })
  return new Map(rows.map((row) => [row.userId, row]))
}

/**
 * Шкала, по которой считается премия сотрудника. Своя шкала профиля
 * работает, только если включена и в ней есть уровни: включённый флаг без
 * уровней не должен оставить человека совсем без шкалы.
 */
export function scaleOf(profile, globalScale) {
  if (profile?.customScale && profile.prizeLevels?.length) return profile.prizeLevels
  return globalScale
}

/** Уровни работы с подсказками профиля поверх общих. */
export function workLevelsOf(profile, workLevels) {
  const hints = (profile?.workHints && typeof profile.workHints === 'object') ? profile.workHints : {}
  return workLevels.map((l) => {
    const own = hints[String(l.position)]
    return { ...l, hint: typeof own === 'string' && own.trim() ? own.trim() : l.hint }
  })
}

/** Есть ли у профиля своя шкала, которая реально применяется. */
export function usesCustomScale(profile) {
  return Boolean(profile?.customScale && profile.prizeLevels?.length)
}
