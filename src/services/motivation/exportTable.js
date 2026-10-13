/**
 * Выгрузка итогов месяца для зарплаты — таблица одна на все форматы
 * (Excel, PDF, Word, CSV, TXT), чтобы цифры в них не могли разойтись.
 * Здесь — сама таблица и два текстовых формата, без библиотек и без базы.
 */

export const EXPORT_FORMATS = ['xlsx', 'pdf', 'docx', 'csv', 'txt']

const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь']

/** «октябрь 2026» из «2026-10». */
export function monthTitle(monthKey) {
  const [y, m] = monthKey.split('-').map(Number)
  return `${MONTHS[m - 1]} ${y}`
}

/** Доллары из центов: целые — без копеек, иначе с двумя знаками. */
export function dollars(cents) {
  const v = (Number(cents) || 0) / 100
  return Number.isInteger(v) ? v : Math.round(v * 100) / 100
}

const dateText = (date) => new Date(date).toLocaleString('ru-RU', {
  day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow',
})

export const COLUMNS = ['№', 'Сотрудник', 'Отдел', 'Роль', 'Профиль', 'Банк, $', 'Баллы', 'Уровень премии', 'К выплате, $', 'Уровень работы']

/**
 * Таблица итогов. rows — строки таблицы команды (живой или из снимка
 * закрытого месяца). Порядок — по отделу, потом по имени: так удобнее
 * сверять с людьми.
 */
export function buildExportTable({ monthKey, rows, closedAt = null }) {
  const sorted = [...rows].sort((a, b) =>
    (a.employee.department?.name || '').localeCompare(b.employee.department?.name || '', 'ru')
      || a.employee.name.localeCompare(b.employee.name, 'ru'))
  const body = sorted.map((r, i) => [
    i + 1,
    r.employee.name,
    r.employee.department?.name || 'Без отдела',
    r.employee.role === 'lead' ? 'руководитель' : 'сотрудник',
    r.profile?.title || '—',
    dollars(r.bankCents),
    r.prizePoints,
    r.currentLevel > 0 ? `${r.currentLevel} из ${r.levelsCount}` : '—',
    dollars(r.earnedCents),
    r.work?.title || '—',
  ])
  const bank = rows.reduce((s, r) => s + r.bankCents, 0)
  const payout = rows.reduce((s, r) => s + r.earnedCents, 0)
  return {
    title: `Мотивация — итоги за ${monthTitle(monthKey)}`,
    status: closedAt
      ? `Месяц закрыт ${dateText(closedAt)}, итоги зафиксированы`
      : 'Месяц ещё не закрыт — цифры предварительные',
    columns: COLUMNS,
    body,
    totals: { people: rows.length, bank: dollars(bank), payout: dollars(payout) },
    totalsRow: ['', `Итого: ${rows.length} чел.`, '', '', '', dollars(bank), '', '', dollars(payout), ''],
  }
}

/** Имя файла: «motivatsiya-2026-10.xlsx». */
export function exportFileName(monthKey, format) {
  return `motivatsiya-${monthKey}.${format}`
}

/**
 * CSV для Excel и Google Таблиц: точка с запятой (русский Excel иначе
 * склеит всё в одну колонку), BOM в начале (иначе кириллица — кракозябры),
 * дробные доллары — с запятой.
 */
export function toCsv(table) {
  const cell = (v) => {
    let s = typeof v === 'number' ? String(v).replace('.', ',') : String(v ?? '')
    // Текст, начинающийся с «=», «+», «-» или «@», Excel выполнит как
    // формулу — апостроф в начале делает его просто текстом.
    if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [table.columns, ...table.body, table.totalsRow].map((row) => row.map(cell).join(';'))
  return `﻿${[table.title, table.status, '', ...lines].join('\r\n')}\r\n`
}

/** TXT — ровными колонками, чтобы читать глазами или вставить в письмо. */
export function toTxt(table) {
  const rows = [table.columns, ...table.body, table.totalsRow].map((row) => row.map((v) => String(v ?? '')))
  const widths = table.columns.map((_, i) => Math.max(...rows.map((r) => r[i].length)))
  const numeric = new Set([0, 5, 6, 8])
  const line = (r) => r.map((v, i) => (numeric.has(i) ? v.padStart(widths[i]) : v.padEnd(widths[i]))).join('  ').trimEnd()
  const rule = widths.map((w) => '-'.repeat(w)).join('  ')
  const [head, ...rest] = rows
  const totals = rest.pop()
  return [table.title, table.status, '', line(head), rule, ...rest.map(line), rule, line(totals), ''].join('\n')
}
