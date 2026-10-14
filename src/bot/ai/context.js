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
 * Данные из CRM для ИИ — коротким текстом. Человеку — только его: задачи,
 * баллы, банк, звонки, отлучка. Яну — сводка по команде. Ровно то, что
 * они и так видят в CRM.
 */

const USER_SELECT = { id: true, name: true, role: true, active: true, departmentId: true, department: { select: { name: true } } }
const STATUS = { today: 'на сегодня', progress: 'в процессе', done: 'готово' }
const dollars = (cents) => `$${(cents / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 })}`

function nowLine(now) {
  const t = new Date(now).toLocaleString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' })
  return `Сейчас: ${t} (Москва).`
}

function motivationLine(row, monthKey, failed = false) {
  if (failed) return 'Данные о баллах и банке сейчас недоступны.'
  if (!row) return 'Мотивации у человека нет.'
  const r = row.result
  const parts = [
    `Мотивация за ${monthTitle(monthKey)}: баллы ${r.prizePoints} из 100`,
    `банк ${dollars(r.bankCents)}`,
    `уровень премии ${r.currentLevel} из ${r.levels.length}`,
    `заработано ${dollars(r.earnedCents)}`,
  ]
  if (r.next) parts.push(`до следующего уровня ${r.next.pointsLeft} баллов`)
  if (r.work?.current) parts.push(`уровень работы «${plain(r.work.current.title, 60)}»`)
  if (row.profile) parts.push(`профиль «${plain(row.profile.title, 60)}»`)
  return `${parts.join(', ')}.`
}

function awayLine(away, now) {
  if (!away) return 'Отлучки сейчас нет.'
  return away.kind === 'break' ? `Сейчас отлучка до ${hm(away.until)}.` : `Сейчас форс-мажор до ${new Date(away.until).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' })}.`
}

async function activeAwayOf(userIds, now) {
  const rows = await prisma.motivationAway.findMany({
    where: { userId: { in: userIds }, endedAt: null, from: { lte: now }, until: { gt: now } },
    orderBy: { until: 'desc' },
  })
  const map = new Map()
  for (const a of rows) if (!map.has(a.userId)) map.set(a.userId, a)
  return map
}

/** Данные для ответа сотруднику (и руководителю отдела — о нём самом). */
export async function staffContext(userId, now = new Date()) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: USER_SELECT })
  if (!user) return ''
  const monthKey = currentMonthKey(now)
  const dayStart = mskDateStart(mskDayKey(now))
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000)

  let rowsFailed = false
  const TASK = { title: true, status: true, deadline: true, startAt: true }
  const [rows, today, overdue, calls, aways, checkin] = await Promise.all([
    computeRows([user], monthKey, now).catch((e) => {
      console.error('[ИИ] баллы для ответа:', e.message)
      rowsFailed = true
      return []
    }),
    // Сегодняшние и просроченные — отдельно: двадцать старых просрочек не
    // должны вытеснить задачи на сегодня.
    prisma.task.findMany({
      where: { ownerId: userId, deadline: { gte: dayStart }, OR: [{ status: { in: ['today', 'progress'] } }, { doneAt: { gte: dayStart } }] },
      orderBy: { deadline: 'asc' },
      take: 15,
      select: TASK,
    }),
    prisma.task.findMany({
      where: { ownerId: userId, deadline: { lt: dayStart }, status: { in: ['today', 'progress'] } },
      orderBy: { deadline: 'desc' },
      take: 10,
      select: TASK,
    }),
    prisma.call.findMany({
      where: { scheduledAt: { gte: now, lt: dayEnd }, OR: [{ ownerId: userId }, { participants: { some: { id: userId } } }] },
      orderBy: { scheduledAt: 'asc' },
      take: 5,
      select: { title: true, scheduledAt: true },
    }),
    activeAwayOf([userId], now),
    prisma.botCheckinAnswer.findFirst({
      where: { userId, status: 'asked', checkin: { closedAt: null, startedAt: { not: null } } },
      select: { checkin: { select: { deadlineAt: true } } },
    }),
  ])

  // Только имя: фамилия ИИ для ответа не нужна.
  const lines = [
    `Сотрудник: ${plain(String(user.name || '').split(/\s+/)[0], 40)}${user.department ? `, отдел ${plain(user.department.name, 40)}` : ''}${user.role === 'lead' ? ', руководитель отдела' : ''}.`,
    nowLine(now),
    motivationLine(rows[0], monthKey, rowsFailed),
    awayLine(aways.get(userId), now),
  ]
  if (checkin) lines.push(`Ждёт ответа на внезапный чек-ин до ${hm(checkin.checkin.deadlineAt)}.`)
  const taskLine = (t) => `- «${plain(t.title, 80)}» — ${STATUS[t.status]}, срок ${t.deadline >= dayStart && t.deadline < dayEnd ? hm(t.deadline) : new Date(t.deadline).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'Europe/Moscow' })}${t.startAt && t.status === 'today' ? `, начало ${hm(t.startAt)}` : ''}`
  lines.push(today.length ? `Задачи на сегодня:\n${today.map(taskLine).join('\n')}` : 'Задач на сегодня нет.')
  if (overdue.length) lines.push(`Просроченные задачи:\n${overdue.map(taskLine).join('\n')}`)
  lines.push(calls.length ? `Звонки сегодня: ${calls.map((c) => `${hm(c.scheduledAt)} «${plain(c.title, 60)}»`).join(', ')}.` : 'Звонков сегодня больше нет.')
  return lines.join('\n')
}

/** Сводка по команде для Яна. */
export async function ownerContext(now = new Date()) {
  const users = await prisma.user.findMany({
    where: { role: { in: PARTICIPANT_ROLES }, active: true },
    select: USER_SELECT,
    orderBy: { name: 'asc' },
    take: 60,
  })
  const ids = users.map((u) => u.id)
  const monthKey = currentMonthKey(now)
  const day = mskDayKey(now)
  const dayStart = mskDateStart(day)

  let rowsFailed = false
  const [rows, aways, breaks, answers, tasks, pending, dayEnds] = await Promise.all([
    computeRows(users, monthKey, now).catch((e) => {
      console.error('[ИИ] баллы команды:', e.message)
      rowsFailed = true
      return []
    }),
    activeAwayOf(ids, now),
    prisma.motivationAway.findMany({ where: { userId: { in: ids }, kind: 'break', from: { gte: dayStart } }, select: { userId: true, from: true, until: true, returnedAt: true } }),
    prisma.botCheckinAnswer.findMany({ where: { userId: { in: ids }, checkin: { day } }, select: { userId: true, status: true, answer: true } }),
    prisma.task.groupBy({ by: ['ownerId', 'status'], where: { ownerId: { in: ids }, status: { in: ['today', 'progress'] } }, _count: true }),
    prisma.motivationReview.count({ where: { status: 'pending' } }),
    // «Закончил день» — по действующей отметке: вернулся — её уже нет.
    prisma.botNotice.findMany({ where: { key: { startsWith: `dayend:${day}:` } }, select: { key: true } }),
  ])
  const rowOf = new Map(rows.map((r) => [r.user.id, r]))
  const ended = new Set(dayEnds.map((n) => n.key.split(':')[2]))
  const CHECKIN = { answered: 'ответил', penalized: 'промолчал (−3)', skipped: 'не спрашивали', asked: 'ещё не ответил' }

  const lines = [nowLine(now), `На проверке ждут решения заявок: ${pending}.`]
  if (rowsFailed) lines.push('Баллы и банки сейчас недоступны.')
  lines.push(`Команда (${users.length} чел.):`)
  for (const u of users) {
    const r = rowOf.get(u.id)?.result
    const parts = [`${plain(u.name, 40)}${u.department ? ` (${plain(u.department.name, 40)}${u.role === 'lead' ? ', руководитель' : ''})` : ''}`]
    if (r) parts.push(`баллы ${r.prizePoints}, банк ${dollars(r.bankCents)}, уровень ${r.currentLevel}/${r.levels.length}`)
    const away = aways.get(u.id)
    parts.push(away ? (away.kind === 'break' ? `сейчас отошёл до ${hm(away.until)}` : `форс-мажор до ${hm(away.until)}`) : ended.has(u.id) ? 'закончил день' : 'на месте')
    const own = breaks.filter((b) => b.userId === u.id)
    if (own.length) {
      const minutes = own.reduce((s, b) => s + Math.max(0, ((b.returnedAt ?? (b.until < now ? b.until : now)) - b.from) / 60000), 0)
      parts.push(`отлучек сегодня ${own.length} (${duration(minutes)})`)
    }
    const a = answers.find((x) => x.userId === u.id)
    if (a) parts.push(`чек-ин: ${CHECKIN[a.status]}${a.status === 'answered' && a.answer ? ` «${plain(a.answer, 80)}»` : ''}`)
    const count = (status) => tasks.find((t) => t.ownerId === u.id && t.status === status)?._count ?? 0
    parts.push(`задач на сегодня ${count('today')}, в процессе ${count('progress')}`)
    lines.push(`- ${parts.join('; ')}`)
  }
  return lines.join('\n')
}

/**
 * Последние сообщения переписки человека с ботом — для памяти. Яну —
 * только его собственные вопросы: в отчётах бота ему цитаты сотрудников,
 * а их ИИ Яна читать не должен.
 */
export async function recentHistory(userId, exceptId = null, { ownOnly = false, take = 4 } = {}) {
  const rows = await prisma.botMessage.findMany({
    where: {
      userId,
      ...(exceptId ? { id: { not: exceptId } } : {}),
      ...(ownOnly ? { direction: { in: ['in', 'reply'] } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take,
    select: { direction: true, text: true, createdAt: true },
  })
  const who = { out: 'бот', in: 'человек', reply: 'человек', button: 'кнопка' }
  return rows.reverse().map((m) => `${hm(m.createdAt)} ${who[m.direction] ?? m.direction}: ${plain(m.text, 300)}`).join('\n')
}
