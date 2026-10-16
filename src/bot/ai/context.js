import { prisma } from '../../config/prisma.js'
import { PARTICIPANT_ROLES } from '../../services/motivation/access.js'
import { currentMonthKey } from '../../services/motivation/month.js'
import { computeRows } from '../../services/motivation/teamRows.js'
import { mskDateStart } from '../../services/motivation/taskRules.js'
import { monthTitle } from '../../services/motivation/exportTable.js'
import { mskDayKey } from '../plan.js'
import { duration, hm } from '../agent/format.js'
import { plain } from './limits.js'

/**
 * Данные из CRM для агента — коротким текстом. Сотруднику — только его:
 * задачи, баллы, банк, звонки, отлучка. Яну — вся команда, руководителю —
 * специалисты его отдела. Ровно то, что они и так видят в CRM.
 *
 * Названия задач, имена и ответы пишут люди — это данные, а не указания:
 * plain() убирает из них переводы строк и ёлочки, чтобы они не подделали
 * разметку подсказки.
 */

const DAY_MS = 24 * 60 * 60 * 1000
const USER_SELECT = { id: true, name: true, role: true, active: true, departmentId: true, department: { select: { name: true } } }
const STATUS = { today: 'не начата', progress: 'в процессе', done: 'готово' }
const dollars = (cents) => `$${(cents / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 })}`
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || 'Сотрудник'
const dateShort = (date) => new Date(date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'Europe/Moscow' })

/**
 * Как называть людей в ответах и отчётах — «(Отдел) Имя», как просил Ян.
 * Два Александра в одном отделе — с первой буквой фамилии.
 */
export function labelsFor(users) {
  const base = (u) => `${u.department?.name ? `(${plain(u.department.name, 40)}) ` : u.role === 'admin' ? '(Владелец) ' : ''}${plain(firstName(u.name), 30)}`
  const counts = new Map()
  for (const u of users) counts.set(base(u), (counts.get(base(u)) ?? 0) + 1)
  return new Map(users.map((u) => {
    const b = base(u)
    const surname = String(u.name || '').trim().split(/\s+/)[1]
    return [u.id, counts.get(b) > 1 && surname ? `${b} ${Array.from(surname)[0]}.` : b]
  }))
}

export const labelOf = (user) => labelsFor([user]).get(user.id)

function nowLine(now) {
  const t = new Date(now).toLocaleString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' })
  return `Сейчас ${t}, время московское.`
}

function dayBounds(now) {
  const start = mskDateStart(mskDayKey(now))
  return { start, end: new Date(start.getTime() + DAY_MS) }
}

function motivationLine(row, monthKey, failed = false) {
  if (failed) return 'Баллы и банк сейчас недоступны.'
  if (!row) return 'Мотивации нет.'
  const r = row.result
  const parts = [
    `Мотивация за ${monthTitle(monthKey)}, баллы ${r.prizePoints} из 100`,
    `банк ${dollars(r.bankCents)}`,
    `уровень премии ${r.currentLevel} из ${r.levels.length}`,
    `заработано ${dollars(r.earnedCents)}`,
  ]
  if (r.next) parts.push(`до следующего уровня ${r.next.pointsLeft} баллов`)
  return `${parts.join(', ')}.`
}

/** Действующие отлучки и форс-мажоры людей: по одной, самой долгой. */
async function activeAwayOf(userIds, now) {
  const rows = await prisma.motivationAway.findMany({
    where: { userId: { in: userIds }, endedAt: null, from: { lte: now }, until: { gt: now } },
    orderBy: { until: 'desc' },
  })
  const map = new Map()
  for (const a of rows) if (!map.has(a.userId)) map.set(a.userId, a)
  return map
}

function awayText(away, ended) {
  if (away) return away.kind === 'break' ? `отошёл до ${hm(away.until)}` : `форс-мажор до ${dateShort(away.until)} ${hm(away.until)}`
  return ended ? 'закончил день' : 'на месте'
}

const TASK_SELECT = {
  id: true, title: true, status: true, deadline: true, startAt: true, doneAt: true, origin: true,
  work: { select: { title: true, client: { select: { name: true } } } },
}

/** Задачи человека, разложенные так, как о них спрашивают. */
async function tasksOf(userId, now, { take = 12 } = {}) {
  const { start, end } = dayBounds(now)
  const open = { ownerId: userId, status: { in: ['today', 'progress'] } }
  const [todayList, progressList, overdueList, doneList, later] = await Promise.all([
    prisma.task.findMany({ where: { ownerId: userId, status: 'today', deadline: { gte: start, lt: end } }, orderBy: { deadline: 'asc' }, take, select: TASK_SELECT }),
    prisma.task.findMany({ where: { ownerId: userId, status: 'progress', deadline: { gte: start } }, orderBy: { deadline: 'asc' }, take, select: TASK_SELECT }),
    prisma.task.findMany({ where: { ...open, deadline: { lt: start } }, orderBy: { deadline: 'desc' }, take, select: TASK_SELECT }),
    prisma.task.findMany({ where: { ownerId: userId, status: 'done', doneAt: { gte: start } }, orderBy: { doneAt: 'desc' }, take, select: TASK_SELECT }),
    prisma.task.count({ where: { ownerId: userId, status: 'today', deadline: { gte: end } } }),
  ])
  return { todayList, progressList, overdueList, doneList, later }
}

function taskLine(t, now) {
  const { start, end } = dayBounds(now)
  const today = t.deadline >= start && t.deadline < end
  const parts = [`«${plain(t.title, 90)}»`]
  parts.push(t.origin === 'hierarchy' ? `Иерархия${t.work ? `, клиент ${plain(t.work.client?.name, 40)}, работа «${plain(t.work.title, 60)}»` : ''}` : 'личная')
  if (t.status === 'done') parts.push(t.doneAt ? `сделана в ${hm(t.doneAt)}` : 'сделана')
  else parts.push(STATUS[t.status], today ? `срок сегодня ${hm(t.deadline)}` : `срок ${dateShort(t.deadline)}`)
  if (t.startAt && t.status === 'today' && today) parts.push(`начало ${hm(t.startAt)}`)
  return `- ${parts.join(', ')}`
}

function tasksBlock(tasks, now) {
  const lines = []
  const block = (title, list, empty) => {
    if (list.length) lines.push(`${title}, ${list.length}\n${list.map((t) => taskLine(t, now)).join('\n')}`)
    else if (empty) lines.push(empty)
  }
  block('Не начатые на сегодня', tasks.todayList, 'Не начатых задач на сегодня нет.')
  block('В процессе', tasks.progressList, 'В процессе задач нет.')
  block('Просроченные', tasks.overdueList, null)
  block('Сделано сегодня', tasks.doneList, 'Сегодня пока ничего не закрыто.')
  if (tasks.later) lines.push(`Не начатых со сроком позже ещё ${tasks.later}.`)
  return lines.join('\n')
}

async function callsOf(userId, now, take = 6) {
  const { end } = dayBounds(now)
  return prisma.call.findMany({
    where: { scheduledAt: { gte: now, lt: end }, OR: [{ ownerId: userId }, { participants: { some: { id: userId } } }] },
    orderBy: { scheduledAt: 'asc' },
    take,
    select: { title: true, scheduledAt: true },
  })
}

const callsLine = (calls) => (calls.length
  ? `Звонки сегодня ${calls.map((c) => `${hm(c.scheduledAt)} «${plain(c.title, 60)}»`).join(', ')}.`
  : 'Звонков сегодня больше нет.')

async function rowsSafe(users, monthKey, now) {
  try {
    return { rows: await computeRows(users, monthKey, now), failed: false }
  } catch (e) {
    console.error('[агент] баллы:', e.message)
    return { rows: [], failed: true }
  }
}

/** О самом человеке — для его разговора с агентом. */
export async function staffBrief(userId, now = new Date()) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: USER_SELECT })
  if (!user) return ''
  const monthKey = currentMonthKey(now)
  const [{ rows, failed }, tasks, calls, aways, checkin, ended] = await Promise.all([
    rowsSafe([user], monthKey, now),
    tasksOf(userId, now),
    callsOf(userId, now),
    activeAwayOf([userId], now),
    prisma.botCheckinAnswer.findFirst({
      where: { userId, status: 'asked', checkin: { closedAt: null, startedAt: { not: null } } },
      select: { checkin: { select: { deadlineAt: true } } },
    }),
    prisma.botNotice.findUnique({ where: { key: `dayend:${mskDayKey(now)}:${userId}` } }),
  ])
  const lines = [
    `Ты говоришь с ${plain(firstName(user.name), 40)}${user.department ? `, отдел ${plain(user.department.name, 40)}` : ''}${user.role === 'lead' ? ', руководитель отдела' : ''}.`,
    nowLine(now),
    `Сейчас ${awayText(aways.get(userId), ended)}.`,
    motivationLine(rows[0], monthKey, failed),
  ]
  if (checkin) lines.push(`Ждёт ответа на внезапный чек-ин до ${hm(checkin.checkin.deadlineAt)}.`)
  lines.push(`Задачи\n${tasksBlock(tasks, now)}`)
  lines.push(callsLine(calls))
  return lines.join('\n')
}

/** Кого видит руководитель или владелец: ни одного лишнего человека. */
export function teamWhere(viewer) {
  if (viewer?.role === 'admin') return { role: { in: PARTICIPANT_ROLES }, active: true }
  if (viewer?.role === 'lead' && viewer.departmentId) return { role: 'staff', active: true, departmentId: viewer.departmentId, id: { not: viewer.id } }
  return { id: '__none__' }
}

/** Сводка по команде, по строке на человека. */
export async function teamBrief(viewer, now = new Date()) {
  const users = await prisma.user.findMany({
    where: teamWhere(viewer),
    select: { ...USER_SELECT, telegram: { select: { chatId: true } } },
    orderBy: [{ department: { name: 'asc' } }, { name: 'asc' }],
    take: 80,
  })
  if (!users.length) return `${nowLine(now)}\nВ команде пока никого нет.`
  const ids = users.map((u) => u.id)
  const monthKey = currentMonthKey(now)
  const day = mskDayKey(now)
  const { start, end } = dayBounds(now)
  const [{ rows, failed }, aways, breaks, answers, open, done, dayEnds, pending] = await Promise.all([
    rowsSafe(users, monthKey, now),
    activeAwayOf(ids, now),
    prisma.motivationAway.findMany({ where: { userId: { in: ids }, kind: 'break', from: { gte: start } }, select: { userId: true, from: true, until: true, returnedAt: true } }),
    prisma.botCheckinAnswer.findMany({ where: { userId: { in: ids }, checkin: { day } }, select: { userId: true, status: true } }),
    prisma.task.findMany({ where: { ownerId: { in: ids }, status: { in: ['today', 'progress'] }, deadline: { lt: end } }, select: { ownerId: true, status: true, deadline: true } }),
    prisma.task.groupBy({ by: ['ownerId'], where: { ownerId: { in: ids }, status: 'done', doneAt: { gte: start } }, _count: true }),
    prisma.botNotice.findMany({ where: { key: { startsWith: `dayend:${day}:` } }, select: { key: true } }),
    viewer.role === 'admin' ? prisma.motivationReview.count({ where: { status: 'pending' } }) : Promise.resolve(null),
  ])
  const rowOf = new Map(rows.map((r) => [r.user.id, r]))
  const ended = new Set(dayEnds.map((n) => n.key.split(':')[2]))
  const labels = labelsFor(users)
  const CHECKIN = { answered: 'ответил', penalized: 'промолчал', skipped: 'не спрашивали', asked: 'ещё не ответил' }

  const lines = [nowLine(now)]
  if (pending !== null) lines.push(`Заявок на баллы ждут решения ${pending}.`)
  if (failed) lines.push('Баллы и банки сейчас недоступны.')
  lines.push(`Команда, ${users.length} чел. Задачи личные и из Иерархии вместе, со сроком до конца сегодня.`)
  for (const u of users) {
    const mine = open.filter((t) => t.ownerId === u.id)
    const parts = [`${labels.get(u.id)}, id ${u.id}${u.role === 'lead' ? ', руководитель' : ''}`]
    parts.push(awayText(aways.get(u.id), ended.has(u.id)))
    parts.push(`задач не начато ${mine.filter((t) => t.status === 'today' && t.deadline >= start).length}, в процессе ${mine.filter((t) => t.status === 'progress' && t.deadline >= start).length}, просрочено ${mine.filter((t) => t.deadline < start).length}, сделано сегодня ${done.find((d) => d.ownerId === u.id)?._count ?? 0}`)
    const r = rowOf.get(u.id)?.result
    if (r) parts.push(`баллы ${r.prizePoints}, банк ${dollars(r.bankCents)}, уровень ${r.currentLevel} из ${r.levels.length}`)
    const own = breaks.filter((b) => b.userId === u.id)
    if (own.length) {
      const minutes = own.reduce((s, b) => s + Math.max(0, ((b.returnedAt ?? (b.until < now ? b.until : now)) - b.from) / 60000), 0)
      parts.push(`отлучек сегодня ${own.length}, всего ${duration(minutes)}`)
    }
    const a = answers.find((x) => x.userId === u.id)
    if (a) parts.push(`чек-ин ${CHECKIN[a.status]}`)
    if (!u.telegram?.chatId) parts.push('телеграм не подключён, написать нельзя')
    lines.push(`- ${parts.join('; ')}`)
  }
  return lines.join('\n')
}

/** Человек, если он в поле зрения того, кто спрашивает. */
export async function personInScope(viewer, personId) {
  if (!personId) return null
  return prisma.user.findFirst({ where: { AND: [teamWhere(viewer), { id: String(personId) }] }, select: { ...USER_SELECT, telegram: { select: { chatId: true } } } })
}

/** Всё о человеке: задачи, работы, мотивация, отлучки, что писал боту. */
export async function personBrief(viewer, personId, now = new Date()) {
  const user = await personInScope(viewer, personId)
  if (!user) return 'Такого человека нет среди тех, кого ты можешь смотреть. Возьми id из сводки по команде.'
  const monthKey = currentMonthKey(now)
  const { start } = dayBounds(now)
  const [{ rows, failed }, tasks, calls, aways, breaks, works, said, ended] = await Promise.all([
    rowsSafe([user], monthKey, now),
    tasksOf(user.id, now, { take: 15 }),
    callsOf(user.id, now),
    activeAwayOf([user.id], now),
    prisma.motivationAway.findMany({ where: { userId: user.id, kind: 'break', from: { gte: start } }, orderBy: { from: 'asc' }, select: { from: true, until: true, returnedAt: true, reason: true } }),
    prisma.work.findMany({
      where: { status: 'active', assignees: { some: { id: user.id } } },
      orderBy: { updatedAt: 'desc' },
      take: 10,
      select: { title: true, client: { select: { name: true } }, tasks: { where: { ownerId: user.id, status: { in: ['today', 'progress'] } }, select: { id: true } } },
    }),
    prisma.botMessage.findMany({
      where: { userId: user.id, direction: { in: ['in', 'reply'] }, createdAt: { gte: new Date(now.getTime() - DAY_MS) } },
      orderBy: { createdAt: 'desc' },
      take: 6,
      select: { text: true, createdAt: true },
    }),
    prisma.botNotice.findUnique({ where: { key: `dayend:${mskDayKey(now)}:${user.id}` } }),
  ])
  const lines = [
    `${labelOf(user)}, id ${user.id}${user.role === 'lead' ? ', руководитель отдела' : ''}${user.telegram?.chatId ? '' : ', телеграм не подключён'}.`,
    `Сейчас ${awayText(aways.get(user.id), ended)}.`,
    motivationLine(rows[0], monthKey, failed),
    `Задачи\n${tasksBlock(tasks, now)}`,
    works.length
      ? `Работы в Иерархии\n${works.map((w) => `- клиент ${plain(w.client?.name, 40)}, «${plain(w.title, 70)}», его открытых задач ${w.tasks.length}`).join('\n')}`
      : 'Работ в Иерархии нет.',
    callsLine(calls),
  ]
  if (breaks.length) lines.push(`Отлучки сегодня\n${breaks.map((b) => `- с ${hm(b.from)} до ${hm(b.returnedAt ?? b.until)}${b.reason ? `, «${plain(b.reason, 60)}»` : ''}`).join('\n')}`)
  if (said.length) lines.push(`Что писал боту за сутки, свежее сверху\n${said.map((m) => `- ${hm(m.createdAt)} «${plain(m.text, 200)}»`).join('\n')}`)
  return lines.join('\n')
}

/** Клиенты и работы в Иерархии: кто ведёт и сколько открытых задач. */
export async function worksBrief(viewer, query = null, now = new Date()) {
  // Работы видят только Ян (все) и руководитель (своего отдела).
  if (viewer?.role !== 'admin' && viewer?.role !== 'lead') return 'Работы в Иерархии тебе не видны.'
  const scope = viewer.role === 'admin' ? {} : { departmentId: viewer.departmentId ?? '__none__' }
  const q = String(query ?? '').trim().slice(0, 60)
  const works = await prisma.work.findMany({
    where: { status: 'active', ...scope, ...(q ? { OR: [{ title: { contains: q, mode: 'insensitive' } }, { client: { name: { contains: q, mode: 'insensitive' } } }] } : {}) },
    orderBy: [{ client: { name: 'asc' } }, { title: 'asc' }],
    take: 40,
    select: {
      title: true,
      client: { select: { name: true } },
      department: { select: { name: true } },
      assignees: { where: { active: true }, select: { id: true, name: true, role: true, department: { select: { name: true } } } },
      tasks: { where: { status: { in: ['today', 'progress'] } }, select: { status: true, deadline: true } },
    },
  })
  if (!works.length) return q ? `Активных работ по «${plain(q, 40)}» нет.` : 'Активных работ нет.'
  const { start } = dayBounds(now)
  return works.map((w) => {
    const people = [...labelsFor(w.assignees).values()].join(', ') || 'никто не назначен'
    return `- клиент ${plain(w.client?.name, 40)}, «${plain(w.title, 70)}», отдел ${plain(w.department?.name, 30)}; ведут ${people}; открытых задач ${w.tasks.length}, в процессе ${w.tasks.filter((t) => t.status === 'progress').length}, просрочено ${w.tasks.filter((t) => t.deadline < start).length}`
  }).join('\n')
}
