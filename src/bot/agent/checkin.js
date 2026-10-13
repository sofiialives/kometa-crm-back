import { prisma } from '../../config/prisma.js'
import { PARTICIPANT_ROLES } from '../../services/motivation/access.js'
import { assignmentAt, getSettingsRow } from '../../services/motivation/profiles.js'
import { autoActiveAt } from '../../services/motivation/taskRules.js'
import { monthKeyOf } from '../../services/motivation/month.js'
import { isMonthClosed } from '../../services/motivation/monthClose.service.js'
import { CHECKIN_ANSWER_MIN, CHECKIN_TO_MIN, isCheckinDay, isWorkday, mskDayKey, mskDayStart, randomCheckinTime } from '../plan.js'
import { escapeHtml } from '../telegram.js'
import { activeAway, hasOpenForceMajeure } from './away.js'
import { hm, points, short } from './format.js'
import { chatOf, nameOf, sendOnce, tell, tellOwners } from './notify.js'

/**
 * Внезапный чек-ин. Каждый третий рабочий день в случайный момент с 11:00
 * до 18:15 бот спрашивает всех сразу: «чем сейчас занят?». 45 минут на
 * ответ. Кто промолчал и не предупреждал (нет метки отлучки или
 * форс-мажора) — −3 событием «Не ответил на внезапный чек-ин» из профиля.
 * Есть нерешённая заявка на форс-мажор — штраф ждёт решения Яна:
 * подтвердил — штрафа нет, не подтвердил — ложится. Вопрос не дошёл (бот
 * заблокирован) — не штрафуем. Яну — отчёт: кто чем занят.
 *
 * Включается в настройках датой «Чек-ины с …»: до неё бот не спрашивает и
 * не штрафует.
 */

const PENALTY_KEY = 'checkin_missed'
const lockUser = (tx, userId) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}))`

/** Запланировать сегодняшний чек-ин, если сегодня его день. */
async function planToday(now, random = Math.random) {
  const today = mskDayKey(now)
  if (!isWorkday(today)) return null
  const existing = await prisma.botCheckin.findUnique({ where: { day: today } })
  if (existing) return existing
  const last = await prisma.botCheckin.findFirst({ where: { day: { lt: today } }, orderBy: { day: 'desc' }, select: { day: true } })
  if (!isCheckinDay(last?.day ?? null, today)) return null

  const latest = new Date(mskDayStart(today).getTime() + CHECKIN_TO_MIN * 60000)
  // Сервер проснулся после 18:15 — сегодня уже не успеть, спросим завтра.
  if (now >= latest) return null
  let plannedAt = randomCheckinTime(today, random)
  if (plannedAt <= now) {
    // Сервер перезапускали, и случайный момент уже прошёл — берём новый из
    // того, что осталось от окна.
    const from = now.getTime() + 5 * 60000
    plannedAt = new Date(Math.min(latest.getTime(), from + Math.floor(random() * Math.max(0, latest.getTime() - from))))
  }
  try {
    return await prisma.botCheckin.create({ data: { day: today, plannedAt } })
  } catch (e) {
    if (e.code === 'P2002') return prisma.botCheckin.findUnique({ where: { day: today } })
    throw e
  }
}

/** Кнопки с задачами «В процессе»: ответить одним нажатием. */
async function taskButtons(userId) {
  const tasks = await prisma.task.findMany({
    where: { ownerId: userId, status: 'progress' },
    orderBy: { updatedAt: 'desc' },
    take: 3,
    select: { id: true, title: true },
  })
  return tasks.map((t) => [{ text: `🔨 ${short(t.title, 36)}`, data: `ci:${t.id}` }])
}

async function start(checkin, now) {
  const claimed = await prisma.botCheckin.updateMany({
    where: { id: checkin.id, startedAt: null },
    data: { startedAt: now, deadlineAt: new Date(now.getTime() + CHECKIN_ANSWER_MIN * 60000) },
  })
  if (!claimed.count) return
  const deadline = new Date(now.getTime() + CHECKIN_ANSWER_MIN * 60000)

  const people = await prisma.user.findMany({
    where: { role: { in: PARTICIPANT_ROLES }, active: true },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  })
  let asked = 0
  for (const person of people) {
    const away = await activeAway(person.id, now)
    const chat = await chatOf(person.id)
    // Заявку на форс-мажор, которую Ян ещё не решил, не пропускаем: спросим,
    // а промолчит — штраф подождёт решения Яна (см. close).
    const skip = away ? (away.kind === 'break' ? `отлучка до ${hm(away.until)}` : `форс-мажор до ${hm(away.until)}`)
      : !chat ? 'нет телеграма' : null
    await prisma.botCheckinAnswer.create({
      data: { checkinId: checkin.id, userId: person.id, status: skip ? 'skipped' : 'asked', answer: skip },
    })
    if (skip) continue
    const res = await tell(person.id,
      `👋 <b>Внезапный чек-ин</b>\n\nЧем сейчас занимаешься? Ответь одной строкой до <b>${hm(deadline)}</b> — или нажми задачу, над которой работаешь.\n\n<i>Нет ответа за 45 минут — −3 балла.</i>`,
      { buttons: await taskButtons(person.id) })
    if (res.ok) asked += 1
    // Вопрос не дошёл (бот заблокирован, сбой телеграма) — за молчание не
    // штрафуем: человек его не видел.
    else await prisma.botCheckinAnswer.updateMany({ where: { checkinId: checkin.id, userId: person.id, status: 'asked' }, data: { status: 'skipped', answer: 'вопрос не доставлен' } })
  }
  console.log(`[агент] чек-ин ${checkin.day}: спросил ${asked} из ${people.length}`)
}

/** Ждёт ли человека открытый чек-ин. */
export async function isAskedNow(userId, now = new Date()) {
  return Boolean(await prisma.botCheckinAnswer.findFirst({
    where: { userId, status: 'asked', checkin: { startedAt: { lte: now }, deadlineAt: { gt: now }, closedAt: null } },
    select: { id: true },
  }))
}

/** Ответ на чек-ин, если человек его сейчас должен. true — записали. */
export async function recordAnswer(userId, answer, now = new Date()) {
  const open = await prisma.botCheckinAnswer.findFirst({
    where: { userId, status: 'asked', checkin: { startedAt: { lte: now }, deadlineAt: { gt: now }, closedAt: null } },
    select: { id: true },
  })
  if (!open) return false
  const updated = await prisma.botCheckinAnswer.updateMany({
    where: { id: open.id, status: 'asked' },
    data: { status: 'answered', answer: String(answer).slice(0, 500), answeredAt: now },
  })
  return updated.count > 0
}

async function penalize(answer, checkin, now) {
  return prisma.$transaction(async (tx) => {
    await lockUser(tx, answer.userId)
    const assignment = await assignmentAt(answer.userId, now, tx)
    const type = assignment?.profile?.eventTypes.find((t) => t.systemKey === PENALTY_KEY && t.enabled)
    let eventId = null
    if (type) {
      const dedupeKey = `checkin:${checkin.day}:${answer.userId}`
      const existing = await tx.motivationEvent.findUnique({ where: { dedupeKey }, select: { id: true } })
      eventId = existing?.id ?? (await tx.motivationEvent.create({
        data: {
          userId: answer.userId,
          profileId: assignment.profileId,
          eventTypeId: type.id,
          kind: 'event',
          mode: 'auto',
          title: type.title,
          prizePoints: type.prizePoints,
          levelPoints: type.levelPoints,
          comment: `Чек-ин ${checkin.day.split('-').reverse().join('.')} в ${hm(checkin.startedAt)}: ответа не было 45 минут`,
          // Отложенный штраф после закрытия месяца ложится в текущий месяц:
          // закрытый уже посчитан.
          occurredAt: (await isMonthClosed(monthKeyOf(checkin.deadlineAt), tx)) ? now : checkin.deadlineAt,
          dedupeKey,
        },
      })).id
    }
    await tx.botCheckinAnswer.update({ where: { id: answer.id }, data: { status: 'penalized', eventId } })
    return type ? type.prizePoints : null
  })
}

// Заявка на форс-мажор ещё у Яна: штраф откладываем до его решения.
const FM_PENDING = 'заявка на форс-мажор ждёт решения Яна'

async function close(checkin, now) {
  const claimed = await prisma.botCheckin.updateMany({ where: { id: checkin.id, closedAt: null }, data: { closedAt: now } })
  if (!claimed.count) return
  const asked = await prisma.botCheckinAnswer.findMany({ where: { checkinId: checkin.id, status: 'asked' } })
  for (const a of asked) {
    // За 45 минут человек мог предупредить, что отошёл, — тогда не штрафуем.
    const away = await activeAway(a.userId, checkin.deadlineAt)
    if (away) {
      await prisma.botCheckinAnswer.update({ where: { id: a.id }, data: { status: 'skipped', answer: 'предупреждение об отлучке' } })
      continue
    }
    if (await hasOpenForceMajeure(a.userId, now)) {
      await prisma.botCheckinAnswer.update({ where: { id: a.id }, data: { status: 'skipped', answer: FM_PENDING } })
      continue
    }
    await penalize(a, checkin, now)
  }
}

/**
 * Ян не подтвердил форс-мажор, а из-за заявки человека не оштрафовали на
 * чек-ине, — штраф ложится сейчас. Возвращает баллы или null.
 */
export async function penalizeIfDeferred(userId, now = new Date()) {
  const answer = await prisma.botCheckinAnswer.findFirst({
    where: {
      userId, status: 'skipped', answer: FM_PENDING,
      checkin: { closedAt: { not: null, gt: new Date(now.getTime() - 48 * 60 * 60 * 1000) } },
    },
    include: { checkin: true },
    orderBy: { createdAt: 'desc' },
  })
  if (!answer) return null
  return penalize(answer, answer.checkin, now)
}

/** Отчёт Яну: кто чем занят, кто промолчал, кого не спрашивали и почему. */
async function report(checkin) {
  const answers = await prisma.botCheckinAnswer.findMany({
    where: { checkinId: checkin.id },
    include: { user: { select: { id: true, name: true } } },
    orderBy: { user: { name: 'asc' } },
  })
  const events = await prisma.motivationEvent.findMany({
    where: { id: { in: answers.map((a) => a.eventId).filter(Boolean) } },
    select: { id: true, prizePoints: true },
  })
  const pointsOf = new Map(events.map((e) => [e.id, e.prizePoints]))
  const lines = { answered: [], skipped: [], penalized: [] }
  for (const a of answers) {
    if (a.status === 'answered') lines.answered.push(`• <b>${nameOf(a.user)}</b> (${hm(a.answeredAt)}): ${escapeHtml(a.answer)}`)
    else if (a.status === 'penalized') {
      const p = pointsOf.get(a.eventId)
      lines.penalized.push(`• ${nameOf(a.user)}${p !== undefined ? ` — ${points(p)}` : ' — в профиле нет события, баллы не сняты'}`)
    } else lines.skipped.push(`• ${nameOf(a.user)} — ${escapeHtml(a.answer || 'пропущен')}`)
  }
  const parts = [`📋 <b>Чек-ин ${hm(checkin.startedAt)}: кто чем занят</b>`]
  if (lines.answered.length) parts.push(lines.answered.join('\n'))
  if (lines.penalized.length) parts.push(`<b>Не ответили:</b>\n${lines.penalized.join('\n')}`)
  if (lines.skipped.length) parts.push(`<b>Не спрашивал или не штрафовал:</b>\n${lines.skipped.join('\n')}`)
  if (answers.length === 0) parts.push('Спрашивать было некого.')
  return sendOnce(`checkin-report:${checkin.id}`, () => tellOwners(parts.join('\n\n')))
}

/** Раз в минуту: запланировать, начать, закрыть. */
export async function tickCheckin(now = new Date(), random = Math.random) {
  const settings = await getSettingsRow()
  // Открытый чек-ин закрываем даже после выключения — люди уже ответили.
  const running = await prisma.botCheckin.findFirst({ where: { startedAt: { not: null }, closedAt: null } })
  if (running && running.deadlineAt <= now) await close(running, now)
  // Отчёт — отдельно от закрытия: не ушёл из-за сбоя — уйдёт следующим проходом.
  const closed = await prisma.botCheckin.findFirst({
    where: { startedAt: { not: null }, closedAt: { not: null, gt: new Date(now.getTime() - 6 * 60 * 60 * 1000) } },
    orderBy: { closedAt: 'desc' },
  })
  if (closed) await report(closed)
  if (!settings.checkinFrom || !autoActiveAt(settings.checkinFrom, now)) return

  const checkin = await planToday(now, random)
  if (!checkin || checkin.startedAt || checkin.closedAt || checkin.plannedAt > now) return
  // Сервер лежал в назначенный момент и проснулся к вечеру — не спрашиваем
  // впритык к звонку, день пропускаем.
  const latest = mskDayStart(checkin.day).getTime() + (CHECKIN_TO_MIN + 15) * 60000
  if (now.getTime() > latest) {
    await prisma.botCheckin.updateMany({ where: { id: checkin.id, startedAt: null }, data: { closedAt: now } })
    return
  }
  await start(checkin, now)
}
