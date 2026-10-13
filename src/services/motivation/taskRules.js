/**
 * Правила автобаллов за задачи — без базы, чтобы их можно было проверить
 * тестами по отдельности. Сервис autoTasks.service.js только достаёт данные
 * и пишет записи в журнал по тому, что решили здесь.
 *
 * Что договорено с заказчиком:
 * - Задача закрыта не позже срока — баллы события «в срок» из профиля.
 *   Задачи из Иерархии и личные идут разными событиями: личные человек
 *   ставит себе сам, за них меньше баллов и дневной потолок.
 * - Задачу вернули из «Готово» — баллы за срок снимаются. Закрыли снова в
 *   срок — начисляются снова.
 * - Просрочка задачи из Иерархии — штраф каждую ночь в 00:00 по Москве,
 *   пока задачу не закроют, но за одну задачу не больше лимита из настроек.
 * - Просрочка личной задачи — штраф один раз: в ту же ночь задачу удаляет
 *   уборка CRM (jobs/clearFinishedTasks.job.js).
 * - Всё это работает только с даты, которую владелец поставил в настройках.
 *   Задачи, просроченные раньше этой даты, не штрафуются.
 * - Отмена владельцем «держится»: прощённый штраф не заменяется штрафом
 *   следующей ночи, а снятые владельцем баллы «в срок» не вернутся, если
 *   перетащить задачу туда и обратно. Сама система отменяет только баллы
 *   «в срок» при возврате из «Готово» — такие возвращаются.
 */
import { MSK_OFFSET_MS, dayKeyOf } from './month.js'

const DAY_MS = 24 * 60 * 60 * 1000

// Больше ночей подряд не штрафуем: лимит на задачу всё равно наступит
// раньше (лимит не больше 100 баллов, штраф не меньше балла).
export const MAX_NIGHTS = 100

/** Начало московских суток, в которые попадает момент. */
export function mskDayStart(date) {
  const t = new Date(date).getTime() + MSK_OFFSET_MS
  return new Date(Math.floor(t / DAY_MS) * DAY_MS - MSK_OFFSET_MS)
}

/** Московская полночь, с которой начинается день «ГГГГ-ММ-ДД». */
export function mskDateStart(dayKey) {
  const [y, m, d] = String(dayKey).split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d) - MSK_OFFSET_MS)
}

/**
 * Настоящая ли это дата «ГГГГ-ММ-ДД» в разумных годах. Date.parse молча
 * переносит 31 февраля на 3 марта, поэтому сверяем, что день не уехал.
 */
export function isRealDayKey(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ''))
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (y < 2020 || y > 2100) return false
  const date = new Date(Date.UTC(y, mo - 1, d))
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d
}

/** Какое событие профиля отвечает за задачу. */
export function ruleFor(task, kind) {
  const personal = task.origin === 'personal'
  if (kind === 'on_time') return personal ? 'personal_task_on_time' : 'task_on_time'
  return personal ? 'personal_task_overdue' : 'task_overdue'
}

/** Закрыта не позже срока. Продлённый срок считается — это осознанный риск. */
export function isOnTime(task) {
  if (task.status !== 'done' || !task.doneAt) return false
  return new Date(task.doneAt).getTime() <= new Date(task.deadline).getTime()
}

/** Автобаллы включены и уже действуют на этот момент. */
export function autoActiveAt(autoFrom, at) {
  if (!autoFrom) return false
  return new Date(at).getTime() >= new Date(autoFrom).getTime()
}

/**
 * Ночи, за которые задача должна получить штраф: каждая московская
 * полночь после срока и до «сейчас», но не раньше даты включения
 * автобаллов и только ещё не проверенные. Штраф датируется последней
 * секундой ушедших суток — так просрочка 31-го остаётся в своём месяце,
 * хотя ночная проверка идёт уже первого числа.
 *
 * checkedUntil — последняя полночь, которую ночной проход уже разобрал.
 * Ночи до неё не трогаем: в ту ночь задача могла лежать в «Готово»,
 * человек мог быть отключён, а событие профиля выключено — тогда штрафа
 * не было, и задним числом его быть не должно. Вернули задачу из «Готово»
 * через две недели — штрафы пойдут с ближайшей ночи, а не за все две
 * недели разом. А ночи, которые сервер проспал, остаются непроверенными, и
 * при запуске они доначисляются.
 *
 * Возвращает [{ at, dayKey }] по порядку.
 */
export function overdueNights({ deadline, autoFrom, checkedUntil = null, now }) {
  if (!autoFrom) return []
  const deadlineMs = new Date(deadline).getTime()
  const fromMs = new Date(autoFrom).getTime()
  // Просроченные до включения задачи не штрафуются вовсе.
  if (deadlineMs < fromMs) return []
  const checkedMs = checkedUntil ? new Date(checkedUntil).getTime() : -Infinity

  const lastMidnight = mskDayStart(now).getTime()
  // Первая полночь строго после срока.
  let midnight = mskDayStart(deadlineMs).getTime() + DAY_MS
  const nights = []
  while (midnight <= lastMidnight && nights.length < MAX_NIGHTS) {
    if (midnight > fromMs && midnight > checkedMs) {
      const at = new Date(midnight - 1000)
      nights.push({ at, dayKey: dayKeyOf(at) })
    }
    midnight += DAY_MS
  }
  return nights
}

/**
 * Занимает ли запись место: живая или отменённая человеком. Такие
 * считаются в лимит штрафа на задачу и не дают начислить «в срок» заново.
 * Отменённая системой (вернули из «Готово») место освобождает.
 */
export function holdsSlot(event) {
  return !event.cancelledAt || Boolean(event.cancelledById)
}

/**
 * Начисление с дневным потолком: сколько ещё можно дать сегодня. Потолок 0
 * — личные задачи баллов не дают совсем.
 */
export function capGain(points, used, cap) {
  if (!(points > 0)) return points || 0
  const left = Math.max(0, cap - Math.max(0, used))
  return Math.min(points, left)
}

/**
 * Штраф с лимитом на задачу: сколько ещё можно снять. used — сколько уже
 * снято по этой задаче (положительным числом). Если событие в профиле
 * почему-то с плюсом, это решение владельца — отдаём как есть.
 */
export function capPenalty(points, used, cap) {
  if (!(points < 0)) return points || 0
  const left = Math.max(0, cap - Math.max(0, used))
  const charged = Math.min(-points, left)
  return charged === 0 ? 0 : -charged
}

/**
 * Ключ записи в журнале, он же защита от повторов. В ключе — правило и
 * задача, поэтому по началу ключа находятся все записи задачи по правилу.
 * - в срок: на каждое закрытие свой ключ (время закрытия), а «не больше
 *   одной живой записи на задачу» проверяет сервис под замком;
 * - просрочка из Иерархии: одна запись на задачу за сутки (дата);
 * - личная просрочка: одна запись на задачу вообще («once»).
 */
export function autoKey(rule, taskId, suffix) {
  return `${autoKeyPrefix(rule, taskId)}${suffix}`
}

/** Начало ключа с двоеточием на конце: id задачи не совпадёт с началом чужого. */
export function autoKeyPrefix(rule, taskId) {
  return `auto:${rule}:${taskId}:`
}

/**
 * Насколько весомой выглядит личная задача — подсказка владельцу в очереди
 * «На проверке», пока оценку не делает ИИ. Считаем буквы и цифры в
 * названии и описании: «тест» или «работа с командой» — лёгкая, пара
 * предложений о том, что именно сделано, — средняя, развёрнутое описание —
 * весомая. Так ставить задачи по одному слову становится невыгодно.
 */
export const COMPLEXITY_THRESHOLDS = { medium: 25, high: 100 }

export function estimateComplexity({ title, description } = {}) {
  const letters = `${title ?? ''} ${description ?? ''}`.replace(/[^\p{L}\p{N}]/gu, '').length
  if (letters >= COMPLEXITY_THRESHOLDS.high) return 'high'
  if (letters >= COMPLEXITY_THRESHOLDS.medium) return 'medium'
  return 'low'
}
