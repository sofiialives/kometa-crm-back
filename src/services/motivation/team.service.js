import { prisma } from '../../config/prisma.js'
import { ApiError } from '../../utils/ApiError.js'
import { computeMonth } from './engine.js'
import { currentMonthKey, isMonthKey, monthKeyOf, monthsBetween, referenceMoment } from './month.js'
import { assertAdmin, assertViewer, EMPLOYEE_SELECT, PARTICIPANT_ROLES } from './access.js'
import { assignmentsAt, getGlobalScale, getWorkLevels, scaleOf, workLevelsOf } from './profiles.js'
import { ensureStartBank, loadJournalsFor } from './journal.js'
import { employeeCard, profileCard } from './shape.js'

/**
 * Раздел «Команда»: таблица сотрудников с банком, баллами, уровнями и
 * заработанным, а под ней «Всего в банках» и «К выплате сейчас».
 *
 * Руководитель видит сотрудников своего отдела — только смотрит, менять
 * ничего не может. Владелец видит всех, у кого есть банк, в том числе
 * руководителей, и фильтрует по отделу.
 * Именно по этой таблице заказчик в конце месяца смотрит, у кого какой
 * уровень, поэтому всё считается тем же расчётом, что и экран сотрудника:
 * цифры в таблице и в карточке человека не могут разойтись.
 */

function resolveMonth(month, now) {
  if (!month) return currentMonthKey(now)
  if (!isMonthKey(month)) throw ApiError.badRequest('Месяц нужен в виде ГГГГ-ММ')
  if (month > currentMonthKey(now)) throw ApiError.badRequest('Будущий месяц ещё не начался')
  return month
}

/** Какие отделы смотрит actor. null — все (админ без фильтра). */
export function departmentScope(actor, departmentId) {
  if (actor.role === 'admin') return departmentId || null
  if (!actor.departmentId) throw ApiError.forbidden('Вы не закреплены ни за одним отделом')
  // Руководителю чужой отдел не открываем, даже если он подставит id руками.
  if (departmentId && departmentId !== actor.departmentId) {
    throw ApiError.forbidden('Можно смотреть только свой отдел')
  }
  return actor.departmentId
}

export async function getTeam(actor, { month, departmentId } = {}, now = new Date()) {
  assertViewer(actor)
  const monthKey = resolveMonth(month, now)
  const scope = departmentScope(actor, departmentId)

  // Руководителю — сотрудники его отдела; себя он смотрит в «Моей мотивации».
  // Владельцу — все, у кого есть банк, и руководители тоже.
  const roles = actor.role === 'admin' ? PARTICIPANT_ROLES : ['staff']
  const users = await prisma.user.findMany({
    where: { role: { in: roles }, ...(scope ? { departmentId: scope } : {}) },
    select: EMPLOYEE_SELECT,
    orderBy: [{ name: 'asc' }, { email: 'asc' }],
  })
  const ids = users.map((u) => u.id)

  const refAt = referenceMoment(monthKey, now)
  const assignments = await assignmentsAt(ids, refAt)

  // Стартовые суммы — до чтения журналов, как и на экране сотрудника.
  // Отключённым и прошлым месяцам ensureStartBank ничего не кладёт.
  await Promise.all(users.map((u) => ensureStartBank(u, monthKey, now)))

  const [journals, globalScale, workLevels] = await Promise.all([
    loadJournalsFor(ids, monthKey),
    getGlobalScale(),
    getWorkLevels(),
  ])

  const rows = []
  for (const user of users) {
    const bankEntries = journals.bank.get(user.id) ?? []
    const events = journals.events.get(user.id) ?? []

    // Отключённого сотрудника показываем, только если в этом месяце у него
    // что-то было: его банк всё ещё входит в «Всего в банках».
    if (!user.active && bankEntries.length === 0 && events.length === 0) continue

    const assignment = assignments.get(user.id)
    const profile = assignment?.profile ?? null
    const result = computeMonth({
      levels: scaleOf(profile, globalScale),
      workLevels: workLevelsOf(profile, workLevels),
      bankEntries,
      events,
    })

    rows.push({
      employee: employeeCard(user),
      profile: profileCard(profile),
      bankCents: result.bankCents,
      prizePoints: result.prizePoints,
      levelPoints: result.levelPoints,
      currentLevel: result.currentLevel,
      levelsCount: result.levels.length,
      earnedCents: result.earnedCents,
      next: result.next,
      work: result.work.current
        ? { position: result.work.current.position, title: result.work.current.title }
        : null,
      eventsCount: events.filter((e) => !e.cancelledAt).length,
    })
  }

  const totals = rows.reduce(
    (acc, r) => ({ bankCents: acc.bankCents + r.bankCents, payoutCents: acc.payoutCents + r.earnedCents }),
    { bankCents: 0, payoutCents: 0 },
  )

  // Админу — список отделов для фильтра. Руководителю он не нужен: у него
  // отдел один.
  const departments = actor.role === 'admin'
    ? await prisma.department.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } })
    : []

  return {
    month: monthKey,
    currentMonth: currentMonthKey(now),
    isCurrent: monthKey === currentMonthKey(now),
    departmentId: scope,
    departments,
    rows,
    totals: { ...totals, employees: rows.length },
    withoutProfile: rows.filter((r) => !r.profile).length,
  }
}

/**
 * Месяцы для переключателя в таблице команды: от первой записи мотивации в
 * агентстве до текущего. Отдельно по людям считать незачем — пустой месяц
 * в таблице и так покажет нули.
 */
export async function teamMonths(actor, now = new Date()) {
  assertViewer(actor)
  const [bank, event, assignment] = await Promise.all([
    prisma.motivationBankEntry.findFirst({ orderBy: { occurredAt: 'asc' }, select: { occurredAt: true } }),
    prisma.motivationEvent.findFirst({ orderBy: { occurredAt: 'asc' }, select: { occurredAt: true } }),
    prisma.motivationAssignment.findFirst({ orderBy: { from: 'asc' }, select: { from: true } }),
  ])
  const current = currentMonthKey(now)
  const firsts = [bank?.occurredAt, event?.occurredAt, assignment?.from].filter(Boolean).map(monthKeyOf).filter((k) => k <= current)
  const from = firsts.length ? firsts.sort()[0] : current
  return monthsBetween(from, current).reverse()
}

/** Кого владелец может выбрать в формах: все активные, у кого есть банк. */
export async function managedEmployees(actor) {
  assertAdmin(actor, 'Начислять может только владелец')
  const where = { role: { in: PARTICIPANT_ROLES }, active: true }
  const users = await prisma.user.findMany({ where, select: EMPLOYEE_SELECT, orderBy: [{ name: 'asc' }, { email: 'asc' }] })
  const assignments = await assignmentsAt(users.map((u) => u.id))
  return users.map((u) => ({ ...employeeCard(u), profile: profileCard(assignments.get(u.id)?.profile) }))
}
