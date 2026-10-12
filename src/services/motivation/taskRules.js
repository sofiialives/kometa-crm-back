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
 * автобаллов. Штраф датируется последней секундой ушедших суток — так
 * просрочка 31-го остаётся в своём месяце, хотя ночная проверка идёт уже
 * первого числа.
 *
 * Возвращает [{ at, dayKey }] по порядку. Пропущенные ночи (сервер спал)
 * сюда тоже попадают: повторный проход их доначислит, а уже начисленные
 * отсекутся ключом записи.
 */
export function overdueNights({ deadline, autoFrom, now }) {
  if (!autoFrom) return []
  const deadlineMs = new Date(deadline).getTime()
  const fromMs = new Date(autoFrom).getTime()
  // Просроченные до включения задачи не штрафуются вовсе.
  if (deadlineMs < fromMs) return []

  const lastMidnight = mskDayStart(now).getTime()
  // Первая полночь строго после срока.
  let midnight = mskDayStart(deadlineMs).getTime() + DAY_MS
  const nights = []
  while (midnight <= lastMidnight && nights.length < MAX_NIGHTS) {
    if (midnight > fromMs) {
      const at = new Date(midnight - 1000)
      nights.push({ at, dayKey: dayKeyOf(at) })
    }
    midnight += DAY_MS
  }
  return nights
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
