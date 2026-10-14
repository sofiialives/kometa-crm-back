import { dayKeyOf } from './month.js'

/**
 * Журнал сотрудника в боте — расчёт без базы: сколько человека не было,
 * опоздал ли, сводка за месяц и раскладка по дням (по Москве).
 */

const minutes = (from, to) => Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60000))

// Бот ждёт 15 минут после срока, прежде чем считать, что человек пропал.
const SILENT_AFTER_MIN = 15
// «Вернулся» позже трёх часов после срока — не возвращение из отлучки, а
// просто следующее сообщение (вечером «ухожу домой», утром «я на месте»).
// Так же считает и бот (away.js): иначе отлучка вышла бы в 6 часов.
const STALE_RETURN_MIN = 3 * 60

const later = (a, b) => (new Date(a) > new Date(b) ? new Date(a) : new Date(b))
const earlier = (a, b) => (new Date(a) < new Date(b) ? new Date(a) : new Date(b))

/**
 * Отлучка в журнале. Вернулся — время до возвращения; срок прошёл, а он не
 * отметился — до срока (и «не отметился»); ещё идёт — до сейчас. Месяц
 * (window) режет минуты: отлучка через полночь 31-го считается по частям.
 */
export function breakItem(away, now = new Date(), window = null) {
  const until = new Date(away.until)
  const returnedRaw = away.returnedAt ? new Date(away.returnedAt) : null
  const staleReturn = returnedRaw && minutes(until, returnedRaw) > STALE_RETURN_MIN
  const returned = staleReturn ? null : returnedRaw
  const endedEarly = away.endedAt && new Date(away.endedAt) < until ? new Date(away.endedAt) : null
  const ongoing = !returnedRaw && !endedEarly && until > now
  const end = returned ?? endedEarly ?? (ongoing ? now : until)
  const late = returned ? minutes(until, returned) : 0
  const from = window ? later(away.from, window.start) : new Date(away.from)
  const to = window ? earlier(end, window.end) : end
  return {
    kind: 'break',
    id: away.id,
    at: from,
    startedBefore: from > new Date(away.from) ? away.from : null,
    until: away.until,
    returnedAt: returned ? away.returnedAt : null,
    minutes: minutes(from, to),
    lateMinutes: late > 1 ? late : 0,
    extensions: away.extensions ?? 0,
    ongoing,
    unmarked: !returned && !endedEarly && !ongoing && (staleReturn || minutes(until, now) >= SILENT_AFTER_MIN),
    source: away.source,
  }
}

/** Форс-мажор в журнале: начался в прошлом месяце — день по началу этого. */
export function forceMajeureItem(away, window = null) {
  const from = window ? later(away.from, window.start) : new Date(away.from)
  return {
    kind: 'force_majeure',
    id: away.id,
    at: from,
    startedBefore: from > new Date(away.from) ? away.from : null,
    until: away.until,
    endedAt: away.endedAt ?? null,
    source: away.source,
    by: away.createdBy?.name ?? null,
    reason: away.reason ?? null,
  }
}

/**
 * Что можно показать смотрящему. Владельцу — всё. Руководителю — только
 * факты: без причин, ответов на чек-ин, слов человека и того, кто решал.
 */
export function redact(item, full) {
  if (full) return item
  const { reason, answer, text, ...rest } = item
  const out = { ...rest, reason: null, answer: null, text: null }
  if (item.kind === 'force_majeure') out.by = null
  if (item.data) {
    const { taskTitle, taskId, startAt, until, approved, deadline, onTime, from, to, nights, points, byOther, told, count } = item.data
    out.data = { taskTitle, taskId, startAt, until, approved, deadline, onTime, from, to, nights, points, byOther, told, count }
  }
  return out
}

/** Сводка за месяц по уже собранным строкам журнала. */
export function summarize(items) {
  const of = (kind) => items.filter((i) => i.kind === kind)
  const breaks = of('break')
  const checkins = of('checkin')
  const count = (status) => checkins.filter((c) => c.status === status).length
  return {
    breaks: breaks.length,
    awayMinutes: breaks.reduce((s, b) => s + b.minutes, 0),
    lateBreaks: breaks.filter((b) => b.lateMinutes > 0).length,
    lateMinutes: breaks.reduce((s, b) => s + b.lateMinutes, 0),
    extensions: breaks.reduce((s, b) => s + b.extensions, 0),
    unmarked: breaks.filter((b) => b.unmarked).length,
    forceMajeure: of('force_majeure').length,
    checkins: {
      asked: checkins.filter((c) => c.status !== 'skipped').length,
      answered: count('answered'),
      penalized: count('penalized'),
      skipped: count('skipped'),
    },
    lateReports: of('late').length + of('task_late').length,
    tasksDone: of('task_done').length,
    tasksDoneLate: of('task_done').filter((i) => i.data?.onTime === false).length,
    tasksOverdue: of('task_overdue').length,
    // Продление руководителем — не заслуга и не вина человека.
    tasksExtended: of('task_extended').filter((i) => !i.data?.byOther).length,
    tasksNotStarted: of('task_not_started').length,
    dayEnds: of('day_end').length,
  }
}

/** По дням, свежие сверху; внутри дня — по времени. Переписка — к своему дню. */
export function groupByDay(items, messages = []) {
  const days = new Map()
  const day = (key) => {
    if (!days.has(key)) days.set(key, { day: key, items: [], messages: [] })
    return days.get(key)
  }
  for (const item of items) day(dayKeyOf(item.at)).items.push(item)
  for (const m of messages) day(dayKeyOf(m.at)).messages.push(m)
  const byTime = (a, b) => new Date(a.at) - new Date(b.at)
  return [...days.values()]
    .map((d) => ({ ...d, items: d.items.sort(byTime), messages: d.messages.sort(byTime) }))
    .sort((a, b) => (a.day < b.day ? 1 : -1))
}
