/**
 * Месяцы мотивации — московские.
 *
 * Банк и баллы обнуляются первого числа, и «первое число» здесь значит
 * полночь по Москве: так живёт агентство, так показывает время весь
 * интерфейс CRM, так же настроены ночные задания (timezone: Europe/Moscow).
 * Сервер на Render работает в UTC, поэтому границы месяца нельзя брать из
 * new Date(год, месяц, 1) — это была бы полночь по времени сервера, и
 * событие в 01:30 первого числа по Москве уехало бы в прошлый месяц.
 *
 * Месяц передаётся строкой «ГГГГ-ММ». Она же уходит на фронт и в адресную
 * строку: в отличие от даты, у неё нет часового пояса, и спутать нечего.
 */

// Москва живёт в UTC+3 круглый год, перехода на летнее время нет с 2014
// года. Поэтому смещение постоянное, и библиотека часовых поясов не нужна.
export const MSK_OFFSET_MS = 3 * 60 * 60 * 1000

const MONTH_KEY = /^(\d{4})-(0[1-9]|1[0-2])$/

export function isMonthKey(value) {
  return typeof value === 'string' && MONTH_KEY.test(value)
}

function pad(n) {
  return String(n).padStart(2, '0')
}

/** «ГГГГ-ММ» того месяца, в который по Москве попадает момент date. */
export function monthKeyOf(date = new Date()) {
  const msk = new Date(new Date(date).getTime() + MSK_OFFSET_MS)
  return `${msk.getUTCFullYear()}-${pad(msk.getUTCMonth() + 1)}`
}

export function currentMonthKey(now = new Date()) {
  return monthKeyOf(now)
}

function parse(key) {
  const m = MONTH_KEY.exec(key)
  if (!m) throw new Error(`Некорректный месяц: ${key}`)
  return { year: Number(m[1]), month: Number(m[2]) }
}

/**
 * Границы месяца как моменты времени: start входит, end уже нет.
 * Полночь первого числа по Москве — это 21:00 последнего дня прошлого
 * месяца по UTC.
 */
export function monthRange(key) {
  const { year, month } = parse(key)
  const start = new Date(Date.UTC(year, month - 1, 1) - MSK_OFFSET_MS)
  const end = new Date(Date.UTC(year, month, 1) - MSK_OFFSET_MS)
  return { start, end }
}

/** Месяц со сдвигом: shiftMonth('2026-01', -1) === '2025-12'. */
export function shiftMonth(key, delta) {
  const { year, month } = parse(key)
  const d = new Date(Date.UTC(year, month - 1 + delta, 1))
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`
}

export function compareMonths(a, b) {
  return a === b ? 0 : a < b ? -1 : 1
}

/** Все месяцы от from до to включительно, по порядку. */
export function monthsBetween(fromKey, toKey) {
  if (compareMonths(fromKey, toKey) > 0) return []
  const out = []
  let key = fromKey
  // Предохранитель от бесконечного цикла на испорченных данных: десяти лет
  // истории мотивации хватит с запасом.
  for (let i = 0; i < 120 && compareMonths(key, toKey) <= 0; i += 1) {
    out.push(key)
    key = shiftMonth(key, 1)
  }
  return out
}

/** Московская дата «ГГГГ-ММ-ДД». Пригодится ночному штрафу за каждый день. */
export function dayKeyOf(date = new Date()) {
  const msk = new Date(new Date(date).getTime() + MSK_OFFSET_MS)
  return `${msk.getUTCFullYear()}-${pad(msk.getUTCMonth() + 1)}-${pad(msk.getUTCDate())}`
}

/**
 * Момент, на который считаются условия месяца: конец месяца для прошлых и
 * «сейчас» для текущего. Профиль, назначенный после закрытия месяца, на
 * этот месяц влиять не должен.
 */
export function referenceMoment(key, now = new Date()) {
  const { end } = monthRange(key)
  return end.getTime() <= now.getTime() ? new Date(end.getTime() - 1) : now
}
