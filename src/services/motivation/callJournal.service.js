import { prisma } from '../../config/prisma.js'
import { ApiError } from '../../utils/ApiError.js'
import { assertAdmin, EMPLOYEE_SELECT, loadEmployee, PARTICIPANT_ROLES } from './access.js'
import { CALL_EVENT_KEYS, callMoment, isAwayAt, journalDayError } from './callRules.js'
import { dayKeyOf } from './month.js'
import { assignmentAt, assignmentsAt } from './profiles.js'
import { employeeCard, person } from './shape.js'

/**
 * Журнал вечернего звонка и метка «форс-мажор до …».
 *
 * Владелец открывает журнал за день и отмечает каждого: был, не был,
 * форс-мажор. «Был» и «не был» сразу ложатся баллами событий профиля
 * «Был на созвоне» и «Пропустил звонок», форс-мажор — без баллов. Не
 * отмеченный — просто не отмечен. Поменял отметку — прежние баллы
 * отменяются с причиной, ложатся новые.
 *
 * Метку «форс-мажор» владелец ставит, когда человек предупредил, что его
 * не будет. Пока она действует, в журнале человек сразу показан как
 * форс-мажор, а бот (когда появится) его не дёргает и чек-ин не штрафует.
 */

const CHANGED_REASON = 'Отметку в журнале звонка изменили'
const MAX_AWAY_DAYS = 31

const lockUser = (tx, userId) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}))`

function assertDay(day, now) {
  const error = journalDayError(day, now)
  if (error) throw ApiError.badRequest(error)
}

function awayCard(away) {
  return away ? { id: away.id, from: away.from, until: away.until, reason: away.reason } : null
}

/** Действующие метки на «сейчас» — для таблицы команды и журнала. */
export async function activeAways(userIds, at = new Date(), db = prisma) {
  if (userIds.length === 0) return new Map()
  const rows = await db.motivationAway.findMany({
    where: { userId: { in: userIds }, endedAt: null, from: { lte: at }, until: { gt: at } },
    orderBy: { until: 'desc' },
  })
  const map = new Map()
  for (const row of rows) if (!map.has(row.userId)) map.set(row.userId, awayCard(row))
  return map
}

/**
 * Журнал за день: все, у кого есть банк, с отметками, баллами из профиля и
 * метками форс-мажора на время звонка.
 */
export async function getJournal(actor, day, now = new Date()) {
  assertAdmin(actor, 'Журнал звонка ведёт владелец')
  assertDay(day, now)
  const at = callMoment(day, now)

  const users = await prisma.user.findMany({
    where: { role: { in: PARTICIPANT_ROLES }, active: true },
    select: EMPLOYEE_SELECT,
    orderBy: { name: 'asc' },
  })
  const ids = users.map((u) => u.id)
  const [marks, aways, assignments, assignmentsNow] = await Promise.all([
    prisma.motivationCallMark.findMany({
      where: { day, userId: { in: ids } },
      include: { event: { select: { prizePoints: true, cancelledAt: true } }, markedBy: { select: { id: true, name: true } } },
    }),
    prisma.motivationAway.findMany({ where: { userId: { in: ids }, endedAt: null, until: { gt: new Date(at.getTime() - 24 * 60 * 60 * 1000) } } }),
    assignmentsAt(ids, at),
    // Профиль назначили уже после звонка (новенький, перевели вечером) —
    // берём текущий, иначе за звонок не было бы баллов вовсе.
    assignmentsAt(ids, now),
  ])
  const markOf = new Map(marks.map((m) => [m.userId, m]))

  const rows = users.map((u) => {
    const profile = (assignments.get(u.id) ?? assignmentsNow.get(u.id))?.profile ?? null
    const pointsOf = (key) => profile?.eventTypes.find((t) => t.systemKey === key && t.enabled)?.prizePoints ?? null
    const mark = markOf.get(u.id)
    const away = aways.find((w) => w.userId === u.id && (isAwayAt(w, at) || isAwayAt(w, now))) ?? null
    return {
      employee: employeeCard(u),
      profile: profile ? { id: profile.id, title: profile.title } : null,
      // Сколько стоит «был» и «не был» по профилю. null — события нет или оно
      // выключено: отметка сохранится, но баллов не даст.
      points: { present: pointsOf(CALL_EVENT_KEYS.present), absent: pointsOf(CALL_EVENT_KEYS.absent) },
      status: mark?.status ?? null,
      awarded: mark?.event && !mark.event.cancelledAt ? mark.event.prizePoints : null,
      markedBy: person(mark?.markedBy),
      away: awayCard(away),
    }
  })

  const count = (status) => rows.filter((r) => r.status === status).length
  return {
    day,
    isToday: day === dayKeyOf(now),
    summary: { present: count('present'), absent: count('absent'), excused: count('excused'), unmarked: count(null), total: rows.length },
    rows,
  }
}

/**
 * Отметить человека: present, absent, excused или null — снять отметку.
 * Повтор той же отметки ничего не меняет.
 */
export async function setMark(actor, day, userId, status, now = new Date()) {
  assertAdmin(actor, 'Журнал звонка ведёт владелец')
  assertDay(day, now)
  const employee = await loadEmployee(userId)
  if (!employee.active) throw ApiError.badRequest('Сотрудник отключён')

  await prisma.$transaction(async (tx) => {
    await lockUser(tx, userId)
    const existing = await tx.motivationCallMark.findUnique({
      where: { day_userId: { day, userId } },
      include: { event: { select: { id: true, cancelledAt: true } } },
    })
    if ((existing?.status ?? null) === status) return

    if (existing?.event && !existing.event.cancelledAt) {
      await tx.motivationEvent.update({
        where: { id: existing.event.id },
        data: { cancelledAt: now, cancelledById: actor.id, cancelReason: CHANGED_REASON },
      })
    }
    if (status === null) {
      if (existing) await tx.motivationCallMark.delete({ where: { id: existing.id } })
      return
    }

    let eventId = null
    const key = CALL_EVENT_KEYS[status]
    if (key) {
      const at = callMoment(day, now)
      const assignment = (await assignmentAt(userId, at, tx)) ?? (await assignmentAt(userId, now, tx))
      const type = assignment?.profile?.eventTypes.find((t) => t.systemKey === key && t.enabled)
      if (type) {
        const event = await tx.motivationEvent.create({
          data: {
            userId,
            profileId: assignment.profileId,
            eventTypeId: type.id,
            kind: 'event',
            mode: 'manual',
            title: type.title,
            prizePoints: type.prizePoints,
            levelPoints: type.levelPoints,
            comment: `Журнал звонка за ${day.split('-').reverse().join('.')}`,
            occurredAt: at,
            createdById: actor.id,
            dedupeKey: `call:${day}:${userId}:${now.getTime()}`,
          },
        })
        eventId = event.id
      }
    }

    await tx.motivationCallMark.upsert({
      where: { day_userId: { day, userId } },
      create: { day, userId, status, eventId, markedById: actor.id },
      update: { status, eventId, markedById: actor.id },
    })
  })
  return getJournalRow(actor, day, userId, now)
}

async function getJournalRow(actor, day, userId, now) {
  const journal = await getJournal(actor, day, now)
  return { row: journal.rows.find((r) => r.employee.id === userId) ?? null, summary: journal.summary }
}

/**
 * Поставить метку «форс-мажор до …». Прежняя действующая метка человека
 * закрывается: у человека одна текущая метка.
 */
export async function setAway(actor, { userId, until, reason }, now = new Date()) {
  assertAdmin(actor, 'Форс-мажор отмечает владелец')
  const employee = await loadEmployee(userId)
  if (!employee.active) throw ApiError.badRequest('Сотрудник отключён')
  const end = new Date(until)
  if (!(end > now)) throw ApiError.badRequest('Время окончания уже прошло')
  if (end.getTime() - now.getTime() > MAX_AWAY_DAYS * 24 * 60 * 60 * 1000) {
    throw ApiError.badRequest('Форс-мажор — не дольше 31 дня. Отпуск и больничный — отдельная история')
  }
  const away = await prisma.$transaction(async (tx) => {
    await lockUser(tx, userId)
    await tx.motivationAway.updateMany({ where: { userId, endedAt: null, until: { gt: now } }, data: { endedAt: now } })
    return tx.motivationAway.create({ data: { userId, from: now, until: end, reason: reason?.trim() || null, createdById: actor.id } })
  })
  return awayCard(away)
}

/** Снять метку раньше срока — человек вернулся. */
export async function endAway(actor, id, now = new Date()) {
  assertAdmin(actor, 'Форс-мажор отмечает владелец')
  const away = await prisma.motivationAway.findUnique({ where: { id } })
  if (!away) throw ApiError.notFound('Метка не найдена')
  if (!away.endedAt && away.until > now) {
    await prisma.motivationAway.update({ where: { id }, data: { endedAt: now } })
  }
  return { ok: true }
}
