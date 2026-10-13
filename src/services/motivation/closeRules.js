/**
 * Правила закрытия месяца без базы — чтобы проверять тестами.
 */
import { monthsBetween, shiftMonth } from './month.js'

/**
 * Какие месяцы закрыть: все прошлые, начиная с первого месяца мотивации, кроме
 * уже закрытых. Текущий месяц ещё идёт — его никогда.
 */
export function monthsToClose(firstMonth, currentMonth, closed = new Set()) {
  if (!firstMonth) return []
  const lastPast = shiftMonth(currentMonth, -1)
  if (firstMonth > lastPast) return []
  return monthsBetween(firstMonth, lastPast).filter((m) => !closed.has(m))
}

/**
 * Карточка человека для снимка — без фото: base64-аватар в каждом месяце
 * раздул бы базу, а показывать удобнее нынешнее фото.
 */
export function snapshotEmployee(card) {
  const { avatarUrl, ...rest } = card
  return rest
}

/** Уровень работы для снимка — целиком, как на экране человека. */
export function snapshotWork(work) {
  return work ? { levels: work.levels, current: work.current, next: work.next, pointsLeft: work.pointsLeft } : null
}

/** Строка снимка в том же виде, что строка живой таблицы команды. */
export function snapshotRow(r, avatarUrl = null) {
  const current = r.work?.current ?? (r.work?.title ? r.work : null)
  return {
    employee: { ...r.employee, avatarUrl: avatarUrl ?? r.employee?.avatarUrl ?? null },
    profile: r.profile,
    bankCents: r.bankCents,
    prizePoints: r.prizePoints,
    levelPoints: r.levelPoints,
    currentLevel: r.currentLevel,
    levelsCount: r.levelsCount,
    earnedCents: r.earnedCents,
    next: null,
    work: current ? { position: current.position, title: current.title } : null,
    eventsCount: r.eventsCount,
    away: null,
  }
}

/** Строки снимка — по имени, как живая таблица. */
export function sortByName(rows) {
  return [...rows].sort((a, b) => a.employee.name.localeCompare(b.employee.name, 'ru'))
}
