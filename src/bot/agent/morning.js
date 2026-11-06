import { prisma } from '../../config/prisma.js'
import { PARTICIPANT_ROLES } from '../../services/motivation/access.js'
import { escapeHtml } from '../telegram.js'
import { isQuietHour, isWorkday, mskDayKey, mskDayStart, mskHour } from '../plan.js'
import { inTeam, labelsFor } from '../ai/context.js'
import { cut, plain } from '../ai/limits.js'
import { morningLines, morningText } from '../ai/morning.js'
import { plainStyle } from '../ai/style.js'
import { activeAway, hasEndedDay } from './away.js'
import { claimNotice, crmButton, firstName, hasNotice, row, sendOnce, tell, tellOwners, unsentKeys } from './notify.js'
import { REPORT_TRIES, sendPart } from './rounds.js'
import { dayBounds, metricWhere, TASK_SELECT, VISIBLE } from './taskScope.js'

/**
 * Утренний обход. По будням в 9:40 по Москве агент пишет каждому сотруднику
 * и руководителю лично: что у него на сегодня, что висит и, если есть из
 * чего, одну задачу на выбор. Ответы он ведёт как разговор по поручению
 * (BotRound с kind morning, те же activeTarget, finish_answer и сбор), а в
 * 10:10 Яну приходит один короткий отчёт по всем, а каждому руководителю по
 * людям его отдела. Задачи за человека агент не ставит, баллов и штрафов нет.
 *
 * Всё, что можно повторить, помнит ключ в BotNotice: сообщение человеку
 * `morning-round:день:человек`, части отчёта `round-report:раунд:часть`.
 */

export const MORNING_TOPIC = 'Утренний обход'
const START_MIN = 9 * 60 + 40
const REPORT_MIN = 10 * 60 + 10
// Вопросы агента идут параллельно и не держат проход: не больше четырёх людей
// сразу, на каждого ~15 секунд, на всех вместе ~60, потом шаблон.
const GREET_PARALLEL = 4
const EACH_MS = 15_000
const TOTAL_MS = 60_000
// Отчёт застрял (процесс перезапустился посреди отправки): через 15 минут берём снова.
// Строки моделью готовятся до захвата, так что отправка занимает секунды.
const REPORT_STUCK_MS = 15 * 60 * 1000
// Отчёт, которого не дождались три часа, уже не нужен.
const REPORT_STALE_MS = 3 * 60 * 60 * 1000
const PERSON = { select: { id: true, name: true, role: true, active: true, departmentId: true, department: { select: { name: true } } } }
const IN = ['in', 'reply', 'file']
const TITLES_IN_REPORT = 5

const timeoutAfter = (ms) => new Promise((resolve) => { setTimeout(() => resolve(null), ms).unref?.() })

/** «3 задачи». */
export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100
  const b = a % 10
  return a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many
}

const mskMinutes = (now) => mskHour(now) * 60 + new Date(now).getUTCMinutes()

// ─── Кому пишем ──────────────────────────────────────────────────────────────

/**
 * Сотрудники и руководители, активные, с телеграмом, кроме отошедших, тех, у
 * кого форс-мажор, и закончивших день. Яна здесь нет: роль admin не участник.
 */
export async function morningPeople(now = new Date()) {
  const people = await prisma.user.findMany({
    where: { role: { in: PARTICIPANT_ROLES }, active: true, telegram: { chatId: { not: null } } },
    select: { id: true, name: true, role: true, departmentId: true, department: { select: { name: true } } },
    orderBy: { name: 'asc' },
  })
  const result = []
  for (const person of people) {
    if (await activeAway(person.id, now)) continue
    if (await hasEndedDay(person.id, now)) continue
    result.push(person)
  }
  return result
}

/** Владелец обхода: первый активный admin с телеграмом, иначе любой активный admin. */
export async function morningOwner() {
  const admins = await prisma.user.findMany({
    where: { role: 'admin', active: true },
    select: { id: true, telegram: { select: { chatId: true } } },
    orderBy: { createdAt: 'asc' },
  })
  return admins.find((a) => a.telegram?.chatId) ?? admins[0] ?? null
}

// ─── Что сказать человеку ────────────────────────────────────────────────────

/**
 * Одна задача на выбор. Сначала просроченная, которую человек ещё не начал,
 * потом открытая из Иерархии со сроком позже сегодняшнего дня. Нет ни той,
 * ни другой, предлагать нечего.
 */
export async function offerFor(userId, now = new Date()) {
  const { end } = dayBounds(now)
  const overdue = await prisma.task.findFirst({
    where: { AND: [VISIBLE, { ownerId: userId, status: 'today' }, metricWhere('overdue', now)] },
    orderBy: { deadline: 'desc' },
    select: TASK_SELECT,
  })
  const found = overdue ?? await prisma.task.findFirst({
    where: { AND: [VISIBLE, { ownerId: userId, origin: 'hierarchy', status: 'today', deadline: { gte: end } }] },
    orderBy: { deadline: 'asc' },
    select: TASK_SELECT,
  })
  if (!found) return null
  return {
    id: found.id,
    title: found.title,
    why: overdue ? 'overdue' : 'hierarchy',
    deadline: found.deadline,
    client: found.work?.client?.name ?? null,
    work: found.work?.title ?? null,
  }
}

/**
 * Числа для шаблона: сегодня, просрочено, открыто по Иерархии. «Сегодня» это
 * все задачи со сроком сегодня в любом статусе (видимые в CRM), так же его
 * считает отчёт.
 */
export async function morningFacts(userId, now = new Date()) {
  const { start, end } = dayBounds(now)
  const [today, overdue, hierarchy] = await Promise.all([
    prisma.task.count({ where: { AND: [VISIBLE, { ownerId: userId, deadline: { gte: start, lt: end } }] } }),
    prisma.task.count({ where: { AND: [VISIBLE, { ownerId: userId }, metricWhere('overdue', now)] } }),
    prisma.task.count({ where: { AND: [VISIBLE, { ownerId: userId, origin: 'hierarchy', status: 'today' }] } }),
  ])
  return { today, overdue, hierarchy }
}

/**
 * Сообщение без модели: из данных человека. Без точек в конце, двоеточий,
 * скобок и слов про срок, как всё в боте. Текст исходный, без HTML.
 */
export function morningTemplate({ name, today = 0, overdue = 0, hierarchy = 0, offer = null }) {
  const lines = [`Доброе утро, ${firstName(name)}`]
  lines.push(today ? `На сегодня у тебя ${today} ${plural(today, 'задача', 'задачи', 'задач')}` : 'На сегодня в CRM пока нет задач')
  if (overdue) lines.push(`Просрочено ${overdue}`)
  if (hierarchy) lines.push(`Открыто по Иерархии ${hierarchy}`)
  if (offer) lines.push(`Может, возьмёшь «${plain(offer.title, 80)}», ${offer.why === 'overdue' ? 'она просрочена' : 'она открыта в Иерархии'}`)
  lines.push('Расставь, пожалуйста, задачи на день')
  return lines.join('\n')
}

// ─── Обход ───────────────────────────────────────────────────────────────────

/** Раунд обхода за этот день, если уже есть. */
function todaysRound(day) {
  return prisma.botRound.findFirst({ where: { kind: 'morning', createdAt: { gte: mskDayStart(day) } } })
}

async function ensureRound(owner, now, day) {
  const found = await todaysRound(day)
  if (found) return found
  return prisma.botRound.create({
    data: {
      ownerId: owner.id,
      topic: MORNING_TOPIC,
      collect: true,
      status: 'sent',
      sentAt: now,
      deadlineAt: new Date(mskDayStart(day).getTime() + REPORT_MIN * 60000),
      kind: 'morning',
    },
  })
}

/** Написать одному: данные, текст агента или шаблон, цель поручения, отправка один раз. */
async function writeTo({ person, round, day, now, ask, deadline, eachMs }) {
  const key = `morning-round:${day}:${person.id}`
  if (await hasNotice(key)) return false
  const [offer, facts] = await Promise.all([offerFor(person.id, now), morningFacts(person.id, now)])
  const left = deadline - Date.now()
  const text = left > 1000
    ? await Promise.race([
      Promise.resolve(ask({ user: person, offer, now, timeoutMs: Math.min(eachMs, left) })).catch(() => null),
      timeoutAfter(Math.min(eachMs, left)),
    ])
    : null
  const raw = text || morningTemplate({ name: person.name, ...facts, offer })
  const body = escapeHtml(raw)
  // В цель кладём исходный текст, без HTML: его читает агент в разговоре.
  const data = { text: cut(raw, 2000), offeredTaskId: offer?.id ?? null }
  const old = await prisma.botRoundTarget.findFirst({ where: { roundId: round.id, userId: person.id } })
  const target = old
    ? await prisma.botRoundTarget.update({ where: { id: old.id }, data })
    : await prisma.botRoundTarget.create({ data: { roundId: round.id, userId: person.id, ...data } })
  const res = await sendOnce(key, () => tell(person.id, body, {
    source: 'round',
    roundTargetId: target.id,
    buttons: [row(crmButton('Открыть задачи', '/tasks'))].filter((r) => r.length),
  }))
  if (res.skipped) return false
  // Не дождались телеграма: сообщение могло дойти, считаем отправленным.
  if (res.ok || res.unsure) {
    await prisma.botRoundTarget.update({ where: { id: target.id }, data: { status: 'sent', sentAt: new Date() } })
    return Boolean(res.ok)
  }
  // Временный сбой освободил ключ: цель остаётся в ожидании, повтор возможен.
  if (!res.retry) await prisma.botRoundTarget.update({ where: { id: target.id }, data: { status: 'failed' } })
  return false
}

let running = null

/**
 * 9:40 по будням: написать каждому лично. Повторный запуск никому не пишет
 * дважды. deps.ask подменяет запрос к агенту, deps.totalMs и deps.eachMs его
 * время. Возвращает, сколько человек получили сообщение.
 */
export function runMorningRound(now = new Date(), deps = {}) {
  // Cron и минутный проход могут столкнуться в одну минуту.
  if (running) return running
  running = doRound(now, deps).finally(() => { running = null })
  return running
}

async function doRound(now, deps) {
  const day = mskDayKey(now)
  if (!isWorkday(day) || isQuietHour(now)) return 0
  if (mskMinutes(now) >= REPORT_MIN) return 0
  const people = await morningPeople(now)
  if (!people.length) return 0
  const owner = await morningOwner()
  if (!owner) {
    // Догоняющий проход идёт каждую минуту: в лог один раз в день.
    if (await claimNotice(`morning-no-owner:${day}`)) console.error('[агент] утренний обход: нет активного владельца (admin), обход не начат')
    return 0
  }
  const round = await ensureRound(owner, now, day)
  const ask = deps.ask ?? morningText
  const deadline = Date.now() + (deps.totalMs ?? TOTAL_MS)
  const queue = [...people]
  let sent = 0
  const worker = async () => {
    for (let person = queue.shift(); person; person = queue.shift()) {
      try {
        if (await writeTo({ person, round, day, now, ask, deadline, eachMs: deps.eachMs ?? EACH_MS })) sent += 1
      } catch (e) {
        console.error(`[агент] утренний обход, сообщение: ${e.name}`)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(deps.parallel ?? GREET_PARALLEL, people.length) }, worker))
  return sent
}

// ─── Отчёт ───────────────────────────────────────────────────────────────────

/** Состояние предложенной задачи к моменту отчёта. */
export function offerState(task, sentAt, now = new Date()) {
  if (!task) return 'gone'
  if (task.status === 'done') return 'done'
  if (task.status === 'progress') return 'progress'
  const { start, end } = dayBounds(now)
  if (task.deadline >= start && task.deadline < end && task.updatedAt >= sentAt) return 'today'
  return 'untouched'
}

const OFFER_WORDS = {
  done: 'уже сделал',
  progress: 'взял в работу',
  today: 'поставил на сегодня',
  untouched: 'пока не взял',
}

// Кому сообщение не ушло совсем (ожидание, пропуск) и кому не дошло.
const SHOWN_STATUSES = ['sent', 'answered', 'failed', 'pending', 'skipped']

/**
 * Свежие данные для отчёта, прямо из базы: сколько задач у человека на
 * сегодня к этому моменту (все статусы со сроком сегодня, видимые в CRM, как
 * в сообщении утром), сколько из них поставлено после сообщения, названия
 * первых пяти, судьба предложенной задачи и ответ. Числа считает база
 * (groupBy), а не длина списка.
 */
export async function gatherMorning(round, now = new Date()) {
  const targets = await prisma.botRoundTarget.findMany({
    where: { roundId: round.id, status: { in: SHOWN_STATUSES } },
    orderBy: { sentAt: 'asc' },
    include: {
      user: PERSON,
      messages: { orderBy: { createdAt: 'asc' }, select: { direction: true, text: true, createdAt: true, fileId: true, fileKind: true, fileMime: true, source: true } },
    },
  })
  const { start, end } = dayBounds(now)
  const sentAt = round.sentAt
  const ids = targets.filter((t) => ['sent', 'answered'].includes(t.status)).map((t) => t.userId)
  const today = { AND: [VISIBLE, { ownerId: { in: ids }, deadline: { gte: start, lt: end } }] }
  const offerIds = targets.map((t) => t.offeredTaskId).filter(Boolean)
  const [totals, freshs, titles, offered] = await Promise.all([
    ids.length ? prisma.task.groupBy({ by: ['ownerId'], where: today, _count: true }) : [],
    ids.length ? prisma.task.groupBy({ by: ['ownerId'], where: { AND: [...today.AND, { createdAt: { gte: sentAt } }] }, _count: true }) : [],
    Promise.all(ids.map(async (id) => [id, await prisma.task.findMany({
      where: { AND: [VISIBLE, { ownerId: id, deadline: { gte: start, lt: end } }] },
      orderBy: { deadline: 'asc' },
      take: TITLES_IN_REPORT,
      select: { title: true, createdAt: true },
    })])),
    offerIds.length
      ? prisma.task.findMany({ where: { AND: [VISIBLE, { id: { in: offerIds }, ownerId: { in: ids } }] }, select: { id: true, ownerId: true, title: true, status: true, deadline: true, updatedAt: true } })
      : [],
  ])
  const total = new Map(totals.map((g) => [g.ownerId, g._count]))
  const fresh = new Map(freshs.map((g) => [g.ownerId, g._count]))
  const names = new Map(titles)
  const offeredById = new Map(offered.map((t) => [t.id, t]))
  const labels = labelsFor(targets.map((t) => t.user))
  return targets.map((t) => {
    // Предложенная должна быть задачей именно этого человека.
    const found = t.offeredTaskId ? offeredById.get(t.offeredTaskId) : null
    const offerTask = found?.ownerId === t.userId ? found : null
    const state = t.offeredTaskId ? offerState(offerTask, t.sentAt ?? sentAt, now) : null
    return {
      id: t.userId,
      userId: t.userId,
      user: t.user,
      label: labels.get(t.userId),
      status: t.status,
      summary: t.summary,
      messages: t.messages,
      answered: t.messages.some((m) => IN.includes(m.direction)),
      tasks: {
        count: total.get(t.userId) ?? 0,
        fresh: fresh.get(t.userId) ?? 0,
        titles: (names.get(t.userId) ?? []).map((x) => ({ title: x.title, fresh: x.createdAt >= sentAt })),
        offer: offerTask && state !== 'gone' ? { title: offerTask.title, state } : null,
      },
    }
  })
}

/** Что человек сам написал, без пометок про файлы. */
function firstWords(p) {
  const m = p.messages.find((x) => IN.includes(x.direction) && !/^\[[^\]]+\]$/.test(x.text))
  return m ? cut(plain(m.text, 200), 120) : null
}

/** Слова людей и названия в стиле бота: без точек в конце, двоеточий, скобок. */
const styled = (text, max) => plainStyle(plain(text, max)).replace(/\s+/g, ' ').trim()

/**
 * Строки про человека без модели: ответ, задачи, предложенная. Различает
 * «на сегодня N» и «поставил после сообщения M». Без точек, двоеточий, скобок.
 */
export function personTemplate(p) {
  const lines = []
  if (p.answered) {
    const said = styled(p.summary || firstWords(p) || '', 200)
    lines.push(said ? `Ответил «${escapeHtml(said)}»` : 'Ответил')
  } else {
    lines.push('Не ответил')
  }
  const { count, titles, offer } = p.tasks
  const fresh = p.tasks.fresh ?? 0
  if (count) {
    lines.push(`На сегодня ${count} ${plural(count, 'задача', 'задачи', 'задач')}`)
    lines.push(fresh ? `После моего сообщения поставил ${fresh}` : 'После моего сообщения ничего не ставил')
    for (const t of titles.slice(0, 3)) lines.push(`«${escapeHtml(styled(t.title, 70))}»`)
    if (count > Math.min(3, titles.length)) lines.push(`и ещё ${count - Math.min(3, titles.length)}`)
  } else {
    lines.push('На сегодня задач нет')
  }
  if (offer) lines.push(`Предложенную «${escapeHtml(styled(offer.title, 70))}» ${OFFER_WORDS[offer.state] ?? 'пока не взял'}`)
  return lines
}

/**
 * Текст отчёта. people — те, кому он адресован; ai — { [userId]: { lines } }
 * или null. Кто не ответил и ничего не поставил, одной строкой имён в конце.
 */
export function morningReportText({ people, ai = null }) {
  const written = people.filter((p) => ['sent', 'answered'].includes(p.status))
  const failed = people.filter((p) => p.status === 'failed')
  const notGot = people.filter((p) => ['pending', 'skipped'].includes(p.status))
  const answered = written.filter((p) => p.answered)
  const placed = written.filter((p) => (p.tasks.fresh ?? 0) > 0)
  const silent = written.filter((p) => !p.answered && !p.tasks.count)
  const shown = written.filter((p) => p.answered || p.tasks.count > 0)
  const lines = [
    '<b>Утренний обход</b>',
    `Ответили ${answered.length} из ${written.length}, после сообщения задачи поставили ${placed.length}`,
  ]
  for (const p of shown) {
    const got = ai?.[p.userId]?.lines
    lines.push('', `<b>${escapeHtml(p.label)}</b>`, ...(got?.length ? got.map((l) => escapeHtml(l)) : personTemplate(p)))
  }
  if (silent.length) lines.push('', `<b>Не ответили и ничего не поставили</b> ${silent.map((p) => escapeHtml(p.label)).join('; ')}`)
  if (failed.length) lines.push('', `<b>Сообщение не дошло</b> ${failed.map((p) => escapeHtml(p.label)).join('; ')}`)
  if (notGot.length) lines.push('', `<b>Не получили сообщение</b> ${notGot.map((p) => escapeHtml(p.label)).join('; ')}`)
  return lines.join('\n')
}

/**
 * Отчёт в 10:10. Один раз: обход переводится в reporting одним запросом.
 * Задачи читаются заново прямо перед отчётом, строки моделью готовятся до
 * захвата частей: захват идёт только перед самой отправкой. Яну идёт отчёт по
 * всем, каждому руководителю по людям его отдела. Каждая часть уходит через
 * sendPart: что уже ушло, второй раз не уйдёт. deps.lines подменяет модель.
 */
export async function sendMorningReport(roundId, now = new Date(), deps = {}) {
  const claimed = await prisma.botRound.updateMany({ where: { id: roundId, status: 'sent', kind: 'morning' }, data: { status: 'reporting', closedAt: now } })
  if (!claimed.count) return { ok: false, reason: 'busy' }
  const round = await prisma.botRound.findUnique({ where: { id: roundId }, include: { owner: PERSON } })
  const close = () => prisma.botRound.update({ where: { id: round.id }, data: { status: 'closed', closedAt: new Date() } })
  const retry = () => prisma.botRound.update({ where: { id: round.id }, data: { status: round.reportTries + 1 >= REPORT_TRIES ? 'closed' : 'sent', reportTries: { increment: 1 } } })
  try {
    if (now.getTime() - round.deadlineAt.getTime() > REPORT_STALE_MS) {
      await close()
      return { ok: false, reason: 'stale' }
    }
    const people = await gatherMorning(round, now)
    if (!people.length) {
      await close()
      return { ok: true, reason: 'nobody' }
    }
    // Строки моделью: общий лимит времени внутри morningLines, кто не успел, получает шаблон.
    // Готовим до отправки, чтобы зависшая модель не держала захваченную часть.
    const ai = await (deps.lines ?? morningLines)({
      ownerId: round.ownerId,
      role: round.owner?.role ?? 'admin',
      people: people.filter((p) => ['sent', 'answered'].includes(p.status) && (p.answered || p.tasks.count > 0)),
    }).catch((e) => {
      console.error(`[агент] утренний отчёт моделью: ${e.name}`)
      return null
    })
    const results = []
    results.push(await sendPart(round.id, 'owner', async () => tellOwners(morningReportText({ people, ai }), { source: 'report' })))
    const leads = await prisma.user.findMany({
      where: { role: 'lead', active: true, telegram: { chatId: { not: null } } },
      select: PERSON.select,
      orderBy: { name: 'asc' },
    })
    for (const lead of leads) {
      const team = people.filter((p) => inTeam(lead, p.user))
      if (!team.length) continue
      results.push(await sendPart(round.id, `lead:${lead.id}`, async () => tell(lead.id, morningReportText({ people: team, ai }), { source: 'report' })))
    }
    // Временный сбой телеграма хоть у одного, повторим только его: ушедшие части не повторяются.
    if (results.some((r) => !r.ok && !r.unsure && r.retry)) {
      await retry()
      return { ok: false, reason: 'telegram' }
    }
    await close()
    return { ok: true }
  } catch (e) {
    console.error(`[агент] утренний отчёт: ${e.name}`)
    await retry().catch(() => {})
    return { ok: false, reason: 'error' }
  }
}

/** Есть ли среди тех, кому пишем, кто ещё не получил утреннее сообщение. */
async function hasUnwritten(now, day) {
  const people = await morningPeople(now)
  if (!people.length) return false
  return (await unsentKeys(people.map((p) => `morning-round:${day}:${p.id}`))).size > 0
}

/**
 * Раз в минуту. До 10:00, пока среди тех, кому пишем, остались люди без
 * сообщения, догоняем обход: сервер был недоступен в 9:40, рестарт посреди
 * обхода или временный сбой телеграма. writeTo идемпотентен, написанным не
 * пишет. Потом отчёт, когда пора, и сброс застрявшего отчёта обхода (у него
 * свой порог, строки моделью готовятся до захвата).
 */
export async function tickMorning(now = new Date()) {
  const day = mskDayKey(now)
  const minutes = mskMinutes(now)
  if (isWorkday(day) && minutes > START_MIN && minutes < 10 * 60 && (await hasUnwritten(now, day))) {
    await runMorningRound(now).catch((e) => console.error('[агент] утренний обход:', e.message))
  }
  await prisma.botRound.updateMany({ where: { kind: 'morning', status: 'reporting', closedAt: { lt: new Date(now.getTime() - REPORT_STUCK_MS) } }, data: { status: 'sent' } })
  const rounds = await prisma.botRound.findMany({
    where: { kind: 'morning', status: 'sent', deadlineAt: { lte: now } },
    orderBy: { deadlineAt: 'asc' },
    take: 5,
  })
  for (const r of rounds) {
    // Отчёт с моделью до минуты: проход им не держим.
    sendMorningReport(r.id, now).catch((e) => console.error(`[агент] утренний отчёт: ${e.name}`))
  }
}
