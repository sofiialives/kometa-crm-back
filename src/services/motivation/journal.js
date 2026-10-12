import { prisma } from '../../config/prisma.js'
import { currentMonthKey, monthKeyOf, monthRange, monthsBetween } from './month.js'
import { assignmentAt } from './profiles.js'

/**
 * Чтение журналов банка и событий за месяц.
 *
 * Отменённые события достаются тоже: расчёт их пропускает, а история
 * показывает зачёркнутыми, с причиной и тем, кто отменил. Так задано:
 * отмена не стирает событие, а оставляет след.
 */

// Кто сделал или отменил запись: только имя, без почты (см. shape.js → person).
const PERSON = { select: { id: true, name: true } }

export const BANK_INCLUDE = {
  createdBy: PERSON,
}

export const EVENT_INCLUDE = {
  createdBy: PERSON,
  cancelledBy: PERSON,
}

function inMonth(monthKey) {
  const { start, end } = monthRange(monthKey)
  return { gte: start, lt: end }
}

/** Журналы одного сотрудника за месяц. */
export async function loadJournals(userId, monthKey, db = prisma) {
  const occurredAt = inMonth(monthKey)
  const [bankEntries, events] = await Promise.all([
    db.motivationBankEntry.findMany({
      where: { userId, occurredAt },
      include: BANK_INCLUDE,
      orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }],
    }),
    db.motivationEvent.findMany({
      where: { userId, occurredAt },
      include: EVENT_INCLUDE,
      orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }],
    }),
  ])
  return { bankEntries, events }
}

/** Журналы многих сотрудников за месяц, разложенные по людям. */
export async function loadJournalsFor(userIds, monthKey, db = prisma) {
  const bank = new Map(userIds.map((id) => [id, []]))
  const events = new Map(userIds.map((id) => [id, []]))
  if (userIds.length === 0) return { bank, events }

  const occurredAt = inMonth(monthKey)
  const [bankRows, eventRows] = await Promise.all([
    db.motivationBankEntry.findMany({
      where: { userId: { in: userIds }, occurredAt },
      orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }],
    }),
    db.motivationEvent.findMany({
      where: { userId: { in: userIds }, occurredAt },
      orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }],
    }),
  ])
  for (const row of bankRows) bank.get(row.userId)?.push(row)
  for (const row of eventRows) events.get(row.userId)?.push(row)
  return { bank, events }
}

/**
 * Стартовая сумма банка.
 *
 * Первого числа банк получает стартовую сумму профиля, если админ её задал.
 * Кладёт её ночное задание в начале месяца (jobs/openMotivationMonth.job.js),
 * а при чтении текущего месяца она проверяется ещё раз — на случай, если
 * сервер в ту ночь не работал. Повторять это безопасно: у стартовой записи
 * уникальный ключ «start:сотрудник:месяц», второй раз она не ляжет.
 *
 * Профиль берётся на начало месяца, а не на сейчас: перевели человека на
 * другую должность десятого числа — стартовая сумма месяца всё равно по
 * той должности, с которой он месяц начал. Назначили профиль в середине
 * месяца — стартовая сумма будет со следующего.
 *
 * Отключённым сотрудникам не кладётся: иначе уволенный каждый месяц
 * всплывал бы в «Команде» с банком и входил в «К выплате».
 *
 * Только для текущего месяца. Задним числом сумму не подставляем: сумма
 * профиля сегодня может быть уже другой.
 */
export async function ensureStartBank(user, monthKey, now = new Date(), db = prisma) {
  if (!user?.active) return false
  if (monthKey !== currentMonthKey(now)) return false

  const dedupeKey = `start:${user.id}:${monthKey}`
  // Сначала смотрим, нет ли уже записи: так обычный просмотр не долбит базу
  // заведомо неудачными вставками.
  if (await db.motivationBankEntry.findUnique({ where: { dedupeKey }, select: { id: true } })) return false

  const { start } = monthRange(monthKey)
  const assignment = await assignmentAt(user.id, start, db)
  const cents = assignment?.profile?.startBankCents ?? 0
  if (cents <= 0) return false

  try {
    await db.motivationBankEntry.create({
      data: {
        userId: user.id,
        kind: 'start',
        amountCents: cents,
        comment: `Стартовая сумма профиля «${assignment.profile.title}»`,
        occurredAt: start,
        dedupeKey,
      },
    })
    return true
  } catch (e) {
    // Кто-то успел положить её одновременно с нами — так и задумано.
    if (e?.code === 'P2002') return false
    throw e
  }
}

/**
 * За какие месяцы у сотрудника есть мотивация: от первого назначения
 * профиля или первой записи в журналах до текущего месяца. Новые сверху —
 * в переключателе месяца чаще нужен свежий.
 */
export async function availableMonths(userId, now = new Date(), db = prisma) {
  const [assignment, bankEntry, event] = await Promise.all([
    db.motivationAssignment.findFirst({ where: { userId }, orderBy: { from: 'asc' }, select: { from: true } }),
    db.motivationBankEntry.findFirst({ where: { userId }, orderBy: { occurredAt: 'asc' }, select: { occurredAt: true } }),
    db.motivationEvent.findFirst({ where: { userId }, orderBy: { occurredAt: 'asc' }, select: { occurredAt: true } }),
  ])
  const current = currentMonthKey(now)
  const firsts = [assignment?.from, bankEntry?.occurredAt, event?.occurredAt]
    .filter(Boolean)
    .map((d) => monthKeyOf(d))
    .filter((k) => k <= current)
  const from = firsts.length ? firsts.sort()[0] : current
  return monthsBetween(from, current).reverse()
}
