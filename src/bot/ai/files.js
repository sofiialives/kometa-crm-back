/**
 * Файлы, которые агент собирает по просьбе Яна: таблица Excel и документ
 * Word. Простые, чёрным Arial, без цветов и рамок: их читают и пересылают
 * дальше, а не любуются оформлением.
 */

const FONT = 'Arial'
const MAX_ROWS = 300
const MAX_COLS = 12
const MAX_CELL = 1000

const clean = (v, max = MAX_CELL) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, max)

/** «Отчёт по команде» → «Отчёт по команде 16.10.xlsx». */
export function fileName(title, ext, now = new Date()) {
  const base = clean(title, 60).replace(/[\\/:*?"<>|«»]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Документ'
  const day = new Date(now).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Moscow' })
  return `${base} ${day}.${ext}`
}

export async function tableFile({ title, columns, rows }, now = new Date()) {
  const { default: ExcelJS } = await import('exceljs')
  const cols = (columns ?? []).slice(0, MAX_COLS).map((c) => clean(c, 100))
  const body = (rows ?? []).slice(0, MAX_ROWS).map((r) => cols.map((_, i) => clean(r?.[i])))
  const book = new ExcelJS.Workbook()
  book.creator = 'KOMETA'
  const sheet = book.addWorksheet('Лист 1', { views: [{ state: 'frozen', ySplit: 3 }] })
  sheet.addRow([clean(title, 200)]).font = { name: FONT, bold: true, size: 14 }
  sheet.addRow([])
  sheet.addRow(cols).font = { name: FONT, bold: true }
  for (const r of body) sheet.addRow(r).font = { name: FONT }
  cols.forEach((c, i) => {
    const col = sheet.getColumn(i + 1)
    const longest = Math.max(c.length, ...body.map((r) => Math.min(String(r[i]).length, 60)))
    col.width = Math.min(60, Math.max(8, longest + 2))
    col.alignment = { wrapText: true, vertical: 'top' }
  })
  return { buffer: Buffer.from(await book.xlsx.writeBuffer()), name: fileName(title, 'xlsx', now), mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
}

export async function documentFile({ title, sections }, now = new Date()) {
  const { Document, HeadingLevel, Packer, Paragraph, TextRun } = await import('docx')
  const run = (text, opts = {}) => new TextRun({ text: clean(text), font: FONT, color: '000000', ...opts })
  const children = [new Paragraph({ spacing: { after: 240 }, children: [run(title, { bold: true, size: 32 })] })]
  for (const s of (sections ?? []).slice(0, 60)) {
    if (s?.heading) children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 240, after: 120 }, children: [run(s.heading, { bold: true, size: 26 })] }))
    for (const p of (s?.paragraphs ?? []).slice(0, 40)) children.push(new Paragraph({ spacing: { after: 120 }, children: [run(p, { size: 22 })] }))
    for (const b of (s?.bullets ?? []).slice(0, 60)) children.push(new Paragraph({ bullet: { level: 0 }, children: [run(b, { size: 22 })] }))
  }
  const doc = new Document({
    creator: 'KOMETA',
    title: clean(title, 200),
    styles: { default: { document: { run: { font: FONT, color: '000000' } } } },
    sections: [{ children }],
  })
  return { buffer: await Packer.toBuffer(doc), name: fileName(title, 'docx', now), mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
}
