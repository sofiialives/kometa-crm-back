import { dayKeyOf } from './month.js'

/**
 * Журнал сотрудника в боте — расчёт без базы: сколько человека не было,
 * опоздал ли, сводка за месяц и раскладка по дням (по Москве).
 */

const minutes = (from, to) => Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60000))

/**
 * Отлучка в журнале. Вернулся — время до возвращения; срок прошёл, а он не
 * отметился — до срока (и помечаем «не отметился»); ещё идёт — до сейчас.
 */
export function breakItem(away, now = new Date()) {
  const returned = away.returnedAt ? new Date(away.returnedAt) : null
  const until = new Date(away.until)
  const ongoing = !returned && !away.endedAt && until > now
  const end = returned ?? (ongoing ? now : (away.endedAt && new Date(away.endedAt) < until ? new Date(away.endedAt) : until))
  const late = returned ? minutes(until, returned) : 0
  return {
    kind: 'break',
    id: away.id,
    at: away.from,
    until: away.until,
    returnedAt: away.returnedAt ?? null,
    minutes: minutes(away.from, end),
    lateMinutes: late > 1 ? late : 0,
    extensions: away.extensions ?? 0,
    ongoing,
    unmarked: !returned && !ongoing && !away.endedAt,
    source: away.source,
  }
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
    tasksTaken: of('task_take').length,
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
