import { prisma } from '../../config/prisma.js'
import { EMPLOYEE_SELECT, PARTICIPANT_ROLES } from './access.js'
import { currentMonthKey, monthKeyOf } from './month.js'
import { employeeCard, profileCard } from './shape.js'
import { computeRows } from './teamRows.js'
import { monthsToClose, snapshotEmployee, snapshotWork } from './closeRules.js'

export { snapshotRow } from './closeRules.js'

/**
 * Закрытие месяца. 1 числа в 00:10 по Москве прошлый месяц закрывается сам:
 * итоги каждого сохраняются снимком (MotivationMonthResult). Дальше прошлый
 * месяц в таблице команды, на экране человека и в выгрузке для зарплаты
 * берётся из снимка — смена шкалы или уровней его уже не меняет, а правки
 * задним числом (отмены, ночные штрафы за проспанные ночи) в закрытый месяц
 * не принимаются.
 *
 * Сервер мог проспать полночь — тогда незакрытые прошлые месяцы закрываются
 * при запуске. Повторное закрытие ничего не делает.
 */

/** Закрытый месяц со снимком или null. */
export async function loadClosedMonth(monthKey, db = prisma) {
  return db.motivationMonthClose.findUnique({ where: { monthKey }, include: { results: true } })
}

/** Закрытые месяцы — набором, для быстрых проверок в цикле. */
export async function closedMonthSet(db = prisma) {
  const rows = await db.motivationMonthClose.findMany({ select: { monthKey: true } })
  return new Set(rows.map((r) => r.monthKey))
}

export async function isMonthClosed(monthKey, db = prisma) {
  return Boolean(await db.motivationMonthClose.findUnique({ where: { monthKey }, select: { monthKey: true } }))
}


/**
 * Закрыть месяц. Только прошлый: текущий ещё идёт. Возвращает, сколько
 * человек попало в снимок, или null, если месяц уже был закрыт.
 */
export async function closeMonth(monthKey, now = new Date()) {
  if (monthKey >= currentMonthKey(now)) return null
  if (await isMonthClosed(monthKey)) return null

  const users = await prisma.user.findMany({
    where: { role: { in: PARTICIPANT_ROLES } },
    select: EMPLOYEE_SELECT,
    orderBy: [{ name: 'asc' }, { email: 'asc' }],
  })
  const rows = await computeRows(users, monthKey, now)

  return prisma.$transaction(async (tx) => {
    // Ночное задание и запуск сервера могут прийти одновременно.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`close:${monthKey}`}))`
    if (await tx.motivationMonthClose.findUnique({ where: { monthKey }, select: { monthKey: true } })) return null
    await tx.motivationMonthClose.create({ data: { monthKey, closedAt: now } })
    if (rows.length) {
      await tx.motivationMonthResult.createMany({
        data: rows.map(({ user, profile, result, eventsCount }) => ({
          monthKey,
          userId: user.id,
          employee: snapshotEmployee(employeeCard(user)),
          profile: profileCard(profile),
          bankCents: result.bankCents,
          earnedCents: result.earnedCents,
          prizePoints: result.prizePoints,
          levelPoints: result.levelPoints,
          currentLevel: result.currentLevel,
          levelsCount: result.levels.length,
          eventsCount,
          levels: result.levels,
          // Уровень работы целиком: экран человека за закрытый месяц берёт
          // его отсюда, как и премию, — пороги потом могли поменять.
          work: snapshotWork(result.work),
        })),
      })
    }
    return { monthKey, people: rows.length }
  })
}

/**
 * Закрыть все прошлые месяцы, которые ещё открыты, — от первого месяца
 * мотивации в агентстве. До запуска вкладки закрывать нечего.
 */
export async function catchUpClose(now = new Date()) {
  const [assignment, bank, event] = await Promise.all([
    prisma.motivationAssignment.findFirst({ orderBy: { from: 'asc' }, select: { from: true } }),
    prisma.motivationBankEntry.findFirst({ orderBy: { occurredAt: 'asc' }, select: { occurredAt: true } }),
    prisma.motivationEvent.findFirst({ orderBy: { occurredAt: 'asc' }, select: { occurredAt: true } }),
  ])
  const firsts = [assignment?.from, bank?.occurredAt, event?.occurredAt].filter(Boolean).map(monthKeyOf).sort()
  const done = []
  for (const monthKey of monthsToClose(firsts[0] ?? null, currentMonthKey(now), await closedMonthSet())) {
    const res = await closeMonth(monthKey, now)
    if (res) done.push(res)
  }
  return done
}
