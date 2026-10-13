import { ApiError } from '../../utils/ApiError.js'
import { prisma } from '../../config/prisma.js'
import { assertAdmin, EMPLOYEE_SELECT, PARTICIPANT_ROLES } from './access.js'
import { currentMonthKey, isMonthKey } from './month.js'
import { loadClosedMonth, snapshotRow } from './monthClose.service.js'
import { employeeCard, profileCard } from './shape.js'
import { computeRows } from './teamRows.js'
import { buildExportTable, EXPORT_FORMATS, exportFileName } from './exportTable.js'
import { renderExport } from './exportFiles.js'

/**
 * Выгрузка итогов месяца для зарплаты. Только владелец. Закрытый месяц —
 * из снимка закрытия, текущий — живым расчётом с пометкой, что цифры
 * предварительные. Все люди с банком, по всем отделам.
 */
export async function exportMonth(actor, { month, format }, now = new Date()) {
  assertAdmin(actor, 'Выгружать итоги может только владелец')
  const monthKey = month || currentMonthKey(now)
  if (!isMonthKey(monthKey)) throw ApiError.badRequest('Месяц нужен в виде ГГГГ-ММ')
  if (monthKey > currentMonthKey(now)) throw ApiError.badRequest('Будущий месяц ещё не начался')
  if (!EXPORT_FORMATS.includes(format)) throw ApiError.badRequest(`Формат — один из: ${EXPORT_FORMATS.join(', ')}`)

  const closed = await loadClosedMonth(monthKey)
  let rows
  if (closed) {
    rows = closed.results.map(snapshotRow)
  } else {
    const users = await prisma.user.findMany({
      where: { role: { in: PARTICIPANT_ROLES } },
      select: EMPLOYEE_SELECT,
      orderBy: [{ name: 'asc' }, { email: 'asc' }],
    })
    rows = (await computeRows(users, monthKey, now)).map(({ user, profile, result }) => ({
      employee: employeeCard(user),
      profile: profileCard(profile),
      bankCents: result.bankCents,
      prizePoints: result.prizePoints,
      currentLevel: result.currentLevel,
      levelsCount: result.levels.length,
      earnedCents: result.earnedCents,
      work: result.work.current ? { title: result.work.current.title } : null,
    }))
  }

  const table = buildExportTable({ monthKey, rows, closedAt: closed?.closedAt ?? null })
  const { buffer, contentType } = await renderExport(table, format)
  return { buffer, contentType, fileName: exportFileName(monthKey, format) }
}
