/**
 * Как агент пишет время и сроки. Всё по Москве — так же, как в CRM.
 */

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000

const msk = (date) => new Date(new Date(date).getTime() + MSK_OFFSET_MS)
const pad = (n) => String(n).padStart(2, '0')

/** «16:30». */
export function hm(date) {
  const d = msk(date)
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

/** «16:30», а если не сегодня — «15.10 в 10:00». */
export function at(date, now = new Date()) {
  const d = msk(date)
  const today = msk(now).toISOString().slice(0, 10)
  if (d.toISOString().slice(0, 10) === today) return hm(date)
  return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)} в ${hm(date)}`
}

/** «5 мин», «1 ч», «1 ч 20 мин». */
export function duration(minutes) {
  const m = Math.max(0, Math.round(minutes))
  if (m < 1) return 'меньше минуты'
  if (m < 60) return `${m} мин`
  const h = Math.floor(m / 60)
  const rest = m % 60
  return rest ? `${h} ч ${rest} мин` : `${h} ч`
}

export const minutesBetween = (from, to) => Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60000)

/** Конец московского дня: 23:59 сегодня. */
export function endOfDay(now = new Date()) {
  const d = msk(now)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59) - MSK_OFFSET_MS)
}

/** Обрезать название задачи для кнопки: телеграм режет длинные некрасиво. */
export function short(text, max = 40) {
  const s = String(text ?? '').trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/** «балл», «балла», «баллов». */
export function points(n) {
  const a = Math.abs(n) % 100
  const b = a % 10
  const word = a > 10 && a < 20 ? 'баллов' : b === 1 ? 'балл' : b >= 2 && b <= 4 ? 'балла' : 'баллов'
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n)} ${word}`
}
