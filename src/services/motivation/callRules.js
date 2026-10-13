/**
 * Правила журнала вечернего звонка и метки «форс-мажор» — без базы, чтобы
 * проверять тестами. Сервис callJournal.service.js только читает и пишет.
 */
import { currentMonthKey, dayKeyOf, monthKeyOf } from './month.js'
import { isRealDayKey, mskDateStart } from './taskRules.js'

// Системные события профиля, которые ставит журнал: «Был на созвоне» и
// «Пропустил звонок». Форс-мажор баллов не даёт.
export const CALL_EVENT_KEYS = { present: 'call_attended', absent: 'call_missed' }
export const CALL_KEYS = Object.values(CALL_EVENT_KEYS)

// Вечерний звонок у команды в 19:00 по Москве.
export const CALL_HOUR_MSK = 19

/**
 * Какой день можно отмечать: настоящая дата, не будущее и текущий месяц.
 * Прошлый месяц уже посчитан — задним числом баллы туда не кладём.
 */
export function journalDayError(dayKey, now = new Date()) {
  if (!isRealDayKey(dayKey)) return 'Дата в виде ГГГГ-ММ-ДД'
  if (dayKey > dayKeyOf(now)) return 'Будущий звонок отметить нельзя'
  if (monthKeyOf(mskDateStart(dayKey)) !== currentMonthKey(now)) return 'Отмечать можно только звонки текущего месяца'
  return null
}

/**
 * Каким моментом датировать баллы за звонок: 19:00 того дня по Москве, но
 * не позже «сейчас» — отметили во время звонка, значит, сейчас.
 */
export function callMoment(dayKey, now = new Date()) {
  const at = new Date(mskDateStart(dayKey).getTime() + CALL_HOUR_MSK * 60 * 60 * 1000)
  return at > now ? new Date(now) : at
}

/** Действует ли метка «форс-мажор» в этот момент. */
export function isAwayAt(away, at) {
  if (!away || away.endedAt) return false
  const t = new Date(at).getTime()
  return new Date(away.from).getTime() <= t && t < new Date(away.until).getTime()
}
