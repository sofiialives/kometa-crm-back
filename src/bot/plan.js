/**
 * Расписание агента без базы: рабочие дни, внезапный чек-ин раз в три
 * рабочих дня в случайное время, окна напоминаний. Всё по Москве.
 */

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

export const CHECKIN_EVERY_WORKDAYS = 3
export const CHECKIN_ANSWER_MIN = 45
// Окно чек-ина: с 11:00 до 18:15, чтобы 45 минут на ответ кончились к 19:00.
export const CHECKIN_FROM_MIN = 11 * 60
export const CHECKIN_TO_MIN = 18 * 60 + 15

/** Московская дата «ГГГГ-ММ-ДД». */
export function mskDayKey(date = new Date()) {
  return new Date(new Date(date).getTime() + MSK_OFFSET_MS).toISOString().slice(0, 10)
}

/** Начало московского дня «ГГГГ-ММ-ДД». */
export function mskDayStart(dayKey) {
  const [y, m, d] = dayKey.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d) - MSK_OFFSET_MS)
}

/** Будний ли день: понедельник–пятница. */
export function isWorkday(dayKey) {
  const dow = new Date(`${dayKey}T00:00:00Z`).getUTCDay()
  return dow >= 1 && dow <= 5
}

/** Сколько рабочих дней прошло после lastDay до day включительно. */
export function workdaysAfter(lastDay, day) {
  let count = 0
  let t = mskDayStart(lastDay).getTime() + DAY_MS
  const end = mskDayStart(day).getTime()
  while (t <= end) {
    if (isWorkday(mskDayKey(t))) count += 1
    t += DAY_MS
  }
  return count
}

/**
 * Нужен ли сегодня чек-ин: только в будни и не раньше, чем через три
 * рабочих дня после прошлого. Первого ещё не было — сегодня.
 */
export function isCheckinDay(lastDay, today) {
  if (!isWorkday(today)) return false
  if (!lastDay) return true
  return workdaysAfter(lastDay, today) >= CHECKIN_EVERY_WORKDAYS
}

/** Случайный момент чек-ина в этот день: с 11:00 до 18:15 по Москве. */
export function randomCheckinTime(dayKey, random = Math.random) {
  const minute = CHECKIN_FROM_MIN + Math.floor(random() * (CHECKIN_TO_MIN - CHECKIN_FROM_MIN + 1))
  return new Date(mskDayStart(dayKey).getTime() + minute * 60000)
}

/** Попадает ли момент в окно «через n минут, ± полминуты» для ежеминутного задания. */
export function dueInMinutes(at, now, minutes) {
  const diff = new Date(at).getTime() - new Date(now).getTime()
  return diff > (minutes - 1) * 60000 && diff <= minutes * 60000
}
