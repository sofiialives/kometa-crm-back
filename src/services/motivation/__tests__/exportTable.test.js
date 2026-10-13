import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { buildExportTable, dollars, exportFileName, monthTitle, toCsv, toTxt } from '../exportTable.js'

const row = (name, dept, extra = {}) => ({
  employee: { name, role: 'staff', department: dept ? { name: dept } : null },
  profile: { title: 'Дизайнер' },
  bankCents: 25000,
  prizePoints: 60,
  currentLevel: 3,
  levelsCount: 5,
  earnedCents: 10000,
  work: { title: 'Сильный результат' },
  ...extra,
})

const rows = [
  row('Роман Котов', 'Дизайн', { bankCents: 1050, earnedCents: 1050, currentLevel: 5 }),
  row('Ольга Смирнова', 'Дизайн', { employee: { name: 'Ольга Смирнова', role: 'lead', department: { name: 'Дизайн' } }, profile: null, currentLevel: 0, work: null }),
  row('Игорь Тестов', 'Разработка'),
]

describe('таблица итогов', () => {
  test('месяц по-русски и имя файла', () => {
    assert.equal(monthTitle('2026-10'), 'октябрь 2026')
    assert.equal(monthTitle('2027-01'), 'январь 2027')
    assert.equal(exportFileName('2026-10', 'xlsx'), 'motivatsiya-2026-10.xlsx')
  })

  test('доллары без лишних копеек', () => {
    assert.equal(dollars(25000), 250)
    assert.equal(dollars(1050), 10.5)
    assert.equal(dollars(0), 0)
  })

  test('строки по отделу и имени, итоги по всем', () => {
    const t = buildExportTable({ monthKey: '2026-10', rows })
    assert.deepEqual(t.body.map((r) => r[1]), ['Ольга Смирнова', 'Роман Котов', 'Игорь Тестов'])
    assert.deepEqual(t.totals, { people: 3, bank: 510.5, payout: 210.5 })
    assert.equal(t.totalsRow[5], 510.5)
  })

  test('руководитель, нет профиля, нет уровня — читаемо, без пустот', () => {
    const t = buildExportTable({ monthKey: '2026-10', rows })
    const olga = t.body[0]
    assert.equal(olga[3], 'руководитель')
    assert.equal(olga[4], '—')
    assert.equal(olga[7], '—')
    assert.equal(olga[9], '—')
    assert.equal(t.body[1][7], '5 из 5')
  })

  test('закрытый и незакрытый месяц подписаны по-разному', () => {
    assert.match(buildExportTable({ monthKey: '2026-10', rows }).status, /предварительные/)
    assert.match(buildExportTable({ monthKey: '2026-10', rows, closedAt: new Date('2026-10-31T21:10:00Z') }).status, /закрыт 1 ноября 2026/)
  })
})

describe('CSV и TXT', () => {
  const t = buildExportTable({ monthKey: '2026-10', rows })

  test('CSV для русского Excel: BOM, точка с запятой, дробные с запятой', () => {
    const csv = toCsv(t)
    assert.ok(csv.startsWith('﻿'))
    assert.ok(csv.includes('№;Сотрудник;Отдел;Роль'))
    assert.ok(csv.includes(';10,5;'))
    assert.ok(csv.includes('Итого: 3 чел.'))
  })

  test('CSV экранирует точку с запятой и кавычки', () => {
    const tricky = buildExportTable({ monthKey: '2026-10', rows: [row('Анна "Аня"; Тестова', 'Разработка')] })
    assert.ok(toCsv(tricky).includes('"Анна ""Аня""; Тестова"'))
  })

  test('TXT ровными колонками с итогом внизу', () => {
    const txt = toTxt(t)
    const lines = txt.split('\n')
    assert.equal(lines[0], 'Мотивация — итоги за октябрь 2026')
    const header = lines[3]
    const igor = lines.find((l) => l.includes('Игорь Тестов'))
    // Колонка «Банк» выровнена: заголовок и значение кончаются в одном месте.
    assert.equal(header.indexOf('Баллы'), igor.indexOf('60') - ('Баллы'.length - '60'.length))
    assert.ok(lines.some((l) => l.includes('Итого: 3 чел.')))
  })
})

describe('CSV не превращает текст в формулы', () => {
  test('имя с «=» в начале выходит текстом', () => {
    const t = buildExportTable({ monthKey: '2026-10', rows: [row('=HYPERLINK("x")', 'Дизайн')] })
    assert.ok(toCsv(t).includes(`"'=HYPERLINK(""x"")"`))
  })
})
