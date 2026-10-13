import { createRequire } from 'node:module'
import { toCsv, toTxt } from './exportTable.js'

/**
 * Файлы выгрузки из одной таблицы (exportTable.js): Excel, PDF, Word, CSV и
 * TXT. Excel — с настоящими числами, чтобы дальше считать в таблице; PDF и
 * Word — для печати и отправки.
 *
 * Библиотеки грузятся при первой выгрузке, а не при старте сервера: они
 * тяжёлые, а нужны раз в месяц, и сбой одной из них не должен ронять весь API.
 */

const require = createRequire(import.meta.url)
let pdfPrinter
async function getPdfPrinter() {
  if (pdfPrinter) return pdfPrinter
  const { default: PdfPrinter } = await import('pdfmake')
  // Шрифт с кириллицей лежит внутри pdfmake: сам Roboto, ничего качать не нужно.
  const vfs = require('pdfmake/build/vfs_fonts.js')
  const font = (name) => Buffer.from(vfs[name], 'base64')
  pdfPrinter = new PdfPrinter({
    Roboto: {
      normal: font('Roboto-Regular.ttf'),
      bold: font('Roboto-Medium.ttf'),
      italics: font('Roboto-Italic.ttf'),
      bolditalics: font('Roboto-MediumItalic.ttf'),
    },
  })
  return pdfPrinter
}

const NUMERIC = new Set([0, 5, 6, 8])
const MONEY = new Set([5, 8])

async function toXlsx(table) {
  const { default: ExcelJS } = await import('exceljs')
  const book = new ExcelJS.Workbook()
  book.creator = 'KOMETA CRM'
  const sheet = book.addWorksheet('Итоги', { views: [{ state: 'frozen', ySplit: 4 }] })
  sheet.addRow([table.title]).font = { bold: true, size: 14 }
  sheet.addRow([table.status]).font = { italic: true, color: { argb: 'FF666666' } }
  sheet.addRow([])
  const head = sheet.addRow(table.columns)
  head.font = { bold: true }
  head.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } } })
  for (const r of table.body) sheet.addRow(r)
  const total = sheet.addRow(table.totalsRow)
  total.font = { bold: true }
  table.columns.forEach((title, i) => {
    const col = sheet.getColumn(i + 1)
    // Две цифры после запятой всегда: «#,##0.##» рисует целые как «150.».
    if (MONEY.has(i)) col.numFmt = '#,##0.00'
    const longest = Math.max(title.length, ...table.body.map((r) => String(r[i] ?? '').length), String(table.totalsRow[i] ?? '').length)
    col.width = Math.min(40, Math.max(6, longest + 2))
  })
  return Buffer.from(await book.xlsx.writeBuffer())
}

async function toPdf(table) {
  const printer = await getPdfPrinter()
  const cell = (v, i, style) => ({ text: String(v ?? ''), alignment: NUMERIC.has(i) ? 'right' : 'left', style })
  const doc = {
    pageSize: 'A4',
    pageOrientation: 'landscape',
    pageMargins: [28, 32, 28, 32],
    defaultStyle: { font: 'Roboto', fontSize: 9 },
    content: [
      { text: table.title, fontSize: 15, bold: true, margin: [0, 0, 0, 4] },
      { text: table.status, color: '#666666', margin: [0, 0, 0, 12] },
      {
        table: {
          headerRows: 1,
          widths: [18, '*', 'auto', 'auto', 'auto', 'auto', 'auto', 'auto', 'auto', 'auto'],
          body: [
            table.columns.map((c, i) => cell(c, i, 'head')),
            ...table.body.map((r) => r.map((v, i) => cell(v, i))),
            table.totalsRow.map((v, i) => cell(v, i, 'head')),
          ],
        },
        layout: 'lightHorizontalLines',
      },
    ],
    styles: { head: { bold: true } },
  }
  return new Promise((resolve, reject) => {
    const pdf = printer.createPdfKitDocument(doc)
    const chunks = []
    pdf.on('data', (c) => chunks.push(c))
    pdf.on('end', () => resolve(Buffer.concat(chunks)))
    pdf.on('error', reject)
    pdf.end()
  })
}

async function toDocx(table) {
  const { AlignmentType, Document, Packer, PageOrientation, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } = await import('docx')
  const cell = (v, i, bold = false) => new TableCell({
    children: [new Paragraph({
      alignment: NUMERIC.has(i) ? AlignmentType.RIGHT : AlignmentType.LEFT,
      children: [new TextRun({ text: String(v ?? ''), bold, size: 18 })],
    })],
  })
  const doc = new Document({
    creator: 'KOMETA CRM',
    title: table.title,
    sections: [{
      properties: { page: { size: { orientation: PageOrientation.LANDSCAPE } } },
      children: [
        new Paragraph({ children: [new TextRun({ text: table.title, bold: true, size: 30 })] }),
        new Paragraph({ spacing: { after: 200 }, children: [new TextRun({ text: table.status, italics: true, color: '666666', size: 20 })] }),
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            new TableRow({ tableHeader: true, children: table.columns.map((c, i) => cell(c, i, true)) }),
            ...table.body.map((r) => new TableRow({ children: r.map((v, i) => cell(v, i)) })),
            new TableRow({ children: table.totalsRow.map((v, i) => cell(v, i, true)) }),
          ],
        }),
      ],
    }],
  })
  return Packer.toBuffer(doc)
}

const TYPES = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  csv: 'text/csv; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
}

/** Файл в нужном формате: { buffer, contentType }. */
export async function renderExport(table, format) {
  let buffer
  if (format === 'xlsx') buffer = await toXlsx(table)
  else if (format === 'pdf') buffer = await toPdf(table)
  else if (format === 'docx') buffer = await toDocx(table)
  else if (format === 'csv') buffer = Buffer.from(toCsv(table), 'utf8')
  else if (format === 'txt') buffer = Buffer.from(toTxt(table), 'utf8')
  else throw new Error(`Неизвестный формат ${format}`)
  return { buffer, contentType: TYPES[format] }
}
