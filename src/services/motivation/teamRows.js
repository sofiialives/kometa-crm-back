import { computeMonth } from './engine.js'
import { referenceMoment } from './month.js'
import { assignmentsAt, getGlobalScale, getWorkLevels, scaleOf, workLevelsOf } from './profiles.js'
import { ensureStartBank, loadJournalsFor } from './journal.js'

/**
 * Итоги месяца по людям — одним расчётом для таблицы команды, закрытия
 * месяца и выгрузки. Поэтому цифры в таблице, в снимке закрытого месяца и
 * в файле для зарплаты не могут разойтись.
 *
 * Отключённый человек попадает в итоги, только если в этом месяце у него
 * что-то было: его банк всё ещё входит в «Всего в банках».
 */
export async function computeRows(users, monthKey, now = new Date()) {
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
    if (!user.active && bankEntries.length === 0 && events.length === 0) continue

    const profile = assignments.get(user.id)?.profile ?? null
    const result = computeMonth({
      levels: scaleOf(profile, globalScale),
      workLevels: workLevelsOf(profile, workLevels),
      bankEntries,
      events,
    })
    rows.push({ user, profile, result, eventsCount: events.filter((e) => !e.cancelledAt).length })
  }
  return rows
}
