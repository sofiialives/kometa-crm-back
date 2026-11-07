import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildBoard, cardVisible, columnOf, daysWithUs, expenseRows, resolvePaidAt, resolveRange, serviceInPeriod,
  shapeService, totals, dayStart,
} from '../boardRules.js'

const iso = (d) => d.toISOString()
const day = (s) => new Date(`${s}T00:00:00.000Z`)
const month = (key) => resolveRange({ mode: 'month', month: day(`${key}-01`) })

/**
 * Услуга месяца key ('2026-10'). workFrom/workTo остались в базе у старых
 * услуг, и в тестах они нужны, чтобы доказать: на доску они не влияют.
 */
function service(key, { workFrom = null, workTo = null, revenueCents = 100000, expenses = [] } = {}) {
  return {
    month: day(`${key}-01`),
    workFrom: workFrom && day(workFrom),
    workTo: workTo && day(workTo),
    revenueCents,
    expenses,
  }
}

describe('периоды доски', () => {
  test('месяц — от первого числа до первого числа следующего', () => {
    const r = resolveRange({ mode: 'month', month: new Date('2026-11-17T10:00:00.000Z') })
    assert.equal(iso(r.gte), '2026-11-01T00:00:00.000Z')
    assert.equal(iso(r.lt), '2026-12-01T00:00:00.000Z')
  })

  test('за всё время — без границ', () => {
    assert.equal(resolveRange({ mode: 'all' }), null)
  })

  test('произвольный период без дат — без границ, с одной датой — с одной', () => {
    assert.equal(resolveRange({ mode: 'period' }), null)
    const r = resolveRange({ mode: 'period', from: new Date('2026-09-15T00:00:00.000Z') })
    assert.equal(iso(r.gte), '2026-09-15T00:00:00.000Z')
    assert.equal(r.lte, undefined)
  })
})

describe('последние месяцы считаются по Москве', () => {
  test('середина месяца — окно начинается с первого числа нужного месяца', () => {
    const now = new Date('2026-11-15T10:00:00.000Z')
    assert.equal(iso(resolveRange({ mode: 'last', months: 1 }, now).gte), '2026-11-01T00:00:00.000Z')
    assert.equal(iso(resolveRange({ mode: 'last', months: 3 }, now).gte), '2026-09-01T00:00:00.000Z')
  })

  test('в час ночи первого числа по Москве уже новый месяц, хотя по UTC ещё прошлый', () => {
    // 31 октября 22:00 UTC — это 1 ноября 01:00 по Москве.
    const now = new Date('2026-10-31T22:00:00.000Z')
    const r = resolveRange({ mode: 'last', months: 1 }, now)
    assert.equal(iso(r.gte), '2026-11-01T00:00:00.000Z')
  })

  test('ноябрьская услуга в этот момент не «из будущего»', () => {
    const now = new Date('2026-10-31T22:00:00.000Z')
    const r = resolveRange({ mode: 'last', months: 1 }, now)
    const novemberService = new Date('2026-11-01T00:00:00.000Z')
    assert.ok(novemberService >= r.gte && novemberService <= r.lte)
  })

  test('без пяти минут полночь по Москве ещё прежний месяц', () => {
    // 31 октября 20:55 UTC — это 31 октября 23:55 по Москве.
    const now = new Date('2026-10-31T20:55:00.000Z')
    assert.equal(iso(resolveRange({ mode: 'last', months: 1 }, now).gte), '2026-10-01T00:00:00.000Z')
  })

  test('окно переходит через новый год', () => {
    const now = new Date('2027-01-10T12:00:00.000Z')
    assert.equal(iso(resolveRange({ mode: 'last', months: 3 }, now).gte), '2026-11-01T00:00:00.000Z')
  })
})

describe('какие услуги видны в периоде', () => {
  test('услуга видна только в своём месяце', () => {
    const s = service('2026-10')
    assert.equal(serviceInPeriod(s, month('2026-10')), true)
    assert.equal(serviceInPeriod(s, month('2026-11')), false)
    assert.equal(serviceInPeriod(s, month('2026-09')), false)
  })

  test('срок работ ничего не решает: услуга октября с работами до января не видна в ноябре', () => {
    const s = service('2026-10', { workFrom: '2026-10-20', workTo: '2027-01-05' })
    assert.equal(serviceInPeriod(s, month('2026-11')), false)
    assert.equal(serviceInPeriod(s, month('2026-12')), false)
    assert.equal(serviceInPeriod(s, month('2026-10')), true)
  })

  test('за всё время видно всё', () => {
    assert.equal(serviceInPeriod(service('2020-01'), null), true)
  })

  test('последние месяцы: месяц услуги внутри окна', () => {
    const range = resolveRange({ mode: 'last', months: 3 }, new Date('2026-11-17T10:00:00.000Z'))
    assert.equal(serviceInPeriod(service('2026-09'), range), true)
    assert.equal(serviceInPeriod(service('2026-08'), range), false)
    assert.equal(serviceInPeriod(service('2026-11'), range), true)
  })

  test('последние месяцы в первую московскую ночь месяца: услуга нового месяца уже есть', () => {
    const range = resolveRange({ mode: 'last', months: 1 }, new Date('2026-10-31T22:00:00.000Z'))
    assert.equal(serviceInPeriod(service('2026-11'), range), true)
  })

  test('произвольный период: месяц считается по первому числу', () => {
    const range = resolveRange({ mode: 'period', from: day('2026-09-15'), to: day('2026-11-20') })
    assert.equal(serviceInPeriod(service('2026-09'), range), false)
    assert.equal(serviceInPeriod(service('2026-10'), range), true)
    assert.equal(serviceInPeriod(service('2026-11'), range), true)
  })

  test('период с одной границей', () => {
    assert.equal(serviceInPeriod(service('2026-10'), resolveRange({ mode: 'period', from: day('2026-10-01') })), true)
    assert.equal(serviceInPeriod(service('2026-09'), resolveRange({ mode: 'period', from: day('2026-10-01') })), false)
    assert.equal(serviceInPeriod(service('2026-10'), resolveRange({ mode: 'period', to: day('2026-09-30') })), false)
  })
})

describe('итоги только по услугам своего месяца', () => {
  const paidExpense = { amountCents: 20000, paid: true }
  const openExpense = { amountCents: 5000, paid: false }

  test('услуга из другого месяца не попадает ни в выручку, ни в расходы', () => {
    const october = service('2026-10', { revenueCents: 100000, expenses: [paidExpense, openExpense], workTo: '2026-11-10' })
    const november = service('2026-11', { revenueCents: 40000, expenses: [openExpense] })
    const result = totals([october, november], month('2026-11'))
    assert.deepEqual(result, { revenueCents: 40000, expenseCents: 5000, unpaidCents: 5000, profitCents: 35000 })
  })

  test('«не выплачено» — расходы без отметки, на прибыль не влияет', () => {
    const s = service('2026-10', { revenueCents: 100000, expenses: [paidExpense, openExpense] })
    const result = totals([s], month('2026-10'))
    assert.equal(result.unpaidCents, 5000)
    assert.equal(result.expenseCents, 25000)
    assert.equal(result.profitCents, 75000)
  })

  test('за всё время считаются все услуги', () => {
    const a = service('2026-09', { revenueCents: 10000, expenses: [openExpense] })
    const b = service('2026-10', { revenueCents: 20000, expenses: [paidExpense] })
    assert.deepEqual(totals([a, b], null), { revenueCents: 30000, expenseCents: 25000, unpaidCents: 5000, profitCents: 5000 })
  })

  test('пустой набор — нули', () => {
    assert.deepEqual(totals([], month('2026-10')), { revenueCents: 0, expenseCents: 0, unpaidCents: 0, profitCents: 0 })
  })

  test('услуга в ответе: inPeriod и свои цифры, срок работ не добавляется', () => {
    const s = service('2026-10', { revenueCents: 100000, expenses: [paidExpense, openExpense], workTo: '2026-11-10' })
    const shaped = shapeService(s, month('2026-10'))
    assert.equal(shaped.inPeriod, true)
    assert.equal(shaped.revenueCents, 100000)
    assert.equal(shaped.expenseCents, 25000)
    assert.equal(shaped.unpaidCents, 5000)
    assert.equal(shaped.profitCents, 75000)
    assert.equal(shapeService(s, month('2026-11')).inPeriod, false)
  })
})

describe('какие карточки есть в периоде', () => {
  test('есть услуга месяца периода — карточка есть', () => {
    assert.equal(cardVisible({ status: 'active', leftAt: null, serviceCount: 1 }, month('2026-11')), true)
  })

  test('услуг в периоде нет — карточки нет, даже если клиент уже работает', () => {
    const card = { status: 'active', leftAt: null, serviceCount: 0 }
    assert.equal(cardVisible(card, month('2026-10')), false)
    assert.equal(cardVisible(card, month('2027-03')), false)
  })

  test('за всё время видны все карточки', () => {
    assert.equal(cardVisible({ status: 'active', leftAt: null, serviceCount: 0 }, null), true)
  })

  test('ушедший виден в месяце ухода, даже если услуг в нём нет', () => {
    const card = { status: 'left', leftAt: day('2026-10-20'), serviceCount: 0 }
    assert.equal(cardVisible(card, month('2026-10')), true)
    assert.equal(columnOf(card, month('2026-10')), 'left')
  })

  test('ушедший не виден в месяцах до и после ухода, если услуг в них нет', () => {
    const card = { status: 'left', leftAt: day('2026-10-20'), serviceCount: 0 }
    assert.equal(cardVisible(card, month('2026-11')), false)
    assert.equal(cardVisible(card, month('2026-09')), false)
  })

  test('уход считается и в скользящем окне, и в произвольном периоде', () => {
    const card = { status: 'left', leftAt: day('2026-10-20'), serviceCount: 0 }
    assert.equal(cardVisible(card, resolveRange({ mode: 'last', months: 2 }, new Date('2026-11-04T09:00:00.000Z'))), true)
    assert.equal(cardVisible(card, resolveRange({ mode: 'period', from: day('2026-10-15'), to: day('2026-10-31') })), true)
    assert.equal(cardVisible(card, resolveRange({ mode: 'period', from: day('2026-10-21'), to: day('2026-10-31') })), false)
  })

  test('клиент без единой услуги виден в месяце начала работ и больше нигде', () => {
    const card = { status: 'active', leftAt: null, serviceCount: 0, serviceCountTotal: 0, startedAt: new Date('2026-11-05T00:00:00.000Z') }
    assert.equal(cardVisible(card, month('2026-11')), true)
    assert.equal(cardVisible(card, month('2026-10')), false)
    assert.equal(cardVisible(card, month('2026-12')), false)
    assert.equal(cardVisible({ ...card, serviceCountTotal: 1 }, month('2026-11')), false, 'есть услуга в другом месяце — видна только там')
  })

  test('вернувшийся в работу (статус active, дата ухода стёрта) уходом не считается', () => {
    assert.equal(cardVisible({ status: 'active', leftAt: null, serviceCount: 0 }, month('2026-10')), false)
  })
})

describe('колонки по выбранному периоду', () => {
  test('работает — «В работе» в любом периоде', () => {
    assert.equal(columnOf({ status: 'active', leftAt: null }, month('2026-10')), 'active')
    assert.equal(columnOf({ status: 'active', leftAt: null }, null), 'active')
  })

  test('ушёл в этом периоде — «Ушедшие»', () => {
    assert.equal(columnOf({ status: 'left', leftAt: day('2026-10-20') }, month('2026-10')), 'left')
  })

  test('ушёл позже конца периода — в том периоде он ещё «В работе»', () => {
    assert.equal(columnOf({ status: 'left', leftAt: day('2026-11-03') }, month('2026-10')), 'active')
    assert.equal(columnOf({ status: 'left', leftAt: day('2026-11-01') }, month('2026-10')), 'active')
  })

  test('ушёл раньше начала периода, а услуга в нём есть — «Ушедшие»', () => {
    assert.equal(columnOf({ status: 'left', leftAt: day('2026-09-20') }, month('2026-10')), 'left')
  })

  test('за всё время решает статус', () => {
    assert.equal(columnOf({ status: 'left', leftAt: day('2026-11-03') }, null), 'left')
  })

  test('границы произвольного периода и скользящего окна', () => {
    const range = resolveRange({ mode: 'period', from: day('2026-09-15'), to: day('2026-10-10') })
    assert.equal(columnOf({ status: 'left', leftAt: day('2026-10-10') }, range), 'left')
    assert.equal(columnOf({ status: 'left', leftAt: day('2026-10-11') }, range), 'active')
    assert.equal(columnOf({ status: 'left', leftAt: day('2026-09-14') }, range), 'left')
    const last = resolveRange({ mode: 'last', months: 2 }, new Date('2026-11-04T09:00:00.000Z'))
    assert.equal(columnOf({ status: 'left', leftAt: day('2026-10-02') }, last), 'left')
    assert.equal(columnOf({ status: 'left', leftAt: day('2026-08-30') }, last), 'left')
  })
})

describe('отметка «выплачено» у расходов', () => {
  const NOW = new Date('2026-11-04T10:00:00.000Z')
  const TODAY = day('2026-11-04') // сегодняшний день по Москве, полночь UTC
  const EARLIER = day('2026-10-20')
  const CREATED = new Date('2026-10-01T08:00:00.000Z')
  // Расходы услуги, как они лежат в базе до правки.
  const before = [
    { id: 'e1', title: 'Копирайтер', amountCents: 5000, paid: true, paidAt: EARLIER, createdAt: CREATED },
    { id: 'e2', title: 'Дизайнер', amountCents: 3000, paid: false, paidAt: null, createdAt: CREATED },
    // Выплачен до появления отметки: дата неизвестна.
    { id: 'e3', title: 'Подписка', amountCents: 1000, paid: true, paidAt: null, createdAt: CREATED },
  ]

  test('поставили галочку без даты — сегодняшний день по Москве, сняли — пусто', () => {
    assert.equal(iso(resolvePaidAt(null, true, null, NOW)), '2026-11-04T00:00:00.000Z')
    assert.equal(resolvePaidAt(before[0], false, null, NOW), null)
    assert.equal(resolvePaidAt(null, false, null, NOW), null)
  })

  test('«сегодня» — московское: после 21:00 UTC уже следующее число', () => {
    assert.equal(iso(resolvePaidAt(null, true, null, new Date('2026-11-04T20:59:00.000Z'))), '2026-11-04T00:00:00.000Z')
    assert.equal(iso(resolvePaidAt(null, true, null, new Date('2026-11-04T21:00:00.000Z'))), '2026-11-05T00:00:00.000Z')
  })

  test('день, который выбрал владелец, приводится к дню и побеждает прежний', () => {
    assert.equal(iso(resolvePaidAt(null, true, new Date('2026-09-15T17:45:00.000Z'), NOW)), '2026-09-15T00:00:00.000Z')
    assert.equal(iso(resolvePaidAt(before[0], true, day('2026-10-25'), NOW)), '2026-10-25T00:00:00.000Z')
    assert.equal(iso(resolvePaidAt(before[1], true, day('2026-10-25'), NOW)), '2026-10-25T00:00:00.000Z')
  })

  test('снимают галочку — выбранная дата не нужна, дата стирается', () => {
    assert.equal(resolvePaidAt(before[0], false, day('2026-10-25'), NOW), null)
  })

  test('уже выплаченный без выбранного дня остаётся с прежней', () => {
    assert.equal(resolvePaidAt(before[0], true, null, NOW), EARLIER)
  })

  test('выплаченный до появления отметки остаётся без даты: её не выдумываем', () => {
    assert.equal(resolvePaidAt(before[2], true, null, NOW), null)
    assert.equal(iso(resolvePaidAt(before[2], true, day('2026-10-01'), NOW)), '2026-10-01T00:00:00.000Z')
  })

  test('невыплаченный, которому ставят галочку, получает сегодняшний день', () => {
    assert.equal(iso(resolvePaidAt(before[1], true, null, NOW)), '2026-11-04T00:00:00.000Z')
  })

  test('правка услуги не теряет отметку: тот же id, прежняя дата выплаты', () => {
    const [row] = expenseRows([{ id: 'e1', title: ' Копирайтер ', amount: 60, paid: true }], before, NOW)
    assert.equal(row.id, 'e1')
    assert.equal(row.paid, true)
    assert.equal(row.paidAt, EARLIER)
    assert.equal(row.createdAt, CREATED)
    assert.equal(row.title, 'Копирайтер')
    assert.equal(row.amountCents, 6000)
  })

  test('правка услуги: владелец выбрал новую дату выплаты', () => {
    const [row] = expenseRows([{ id: 'e1', title: 'Копирайтер', amount: 50, paid: true, paidAt: day('2026-11-02') }], before, NOW)
    assert.equal(iso(row.paidAt), '2026-11-02T00:00:00.000Z')
  })

  test('если форма про галочку не знает, отметка остаётся как была', () => {
    const rows = expenseRows([
      { id: 'e1', title: 'Копирайтер', amount: 50 },
      { id: 'e2', title: 'Дизайнер', amount: 30 },
      { id: 'e3', title: 'Подписка', amount: 10 },
    ], before, NOW)
    assert.deepEqual(rows.map((r) => [r.paid, r.paidAt]), [[true, EARLIER], [false, null], [true, null]])
  })

  test('галочку снимают — дата стирается', () => {
    const [row] = expenseRows([{ id: 'e1', title: 'Копирайтер', amount: 50, paid: false }], before, NOW)
    assert.equal(row.paid, false)
    assert.equal(row.paidAt, null)
  })

  test('галочку ставят у прежнего расхода — сегодняшний день', () => {
    const [row] = expenseRows([{ id: 'e2', title: 'Дизайнер', amount: 30, paid: true }], before, NOW)
    assert.equal(row.paid, true)
    assert.equal(iso(row.paidAt), '2026-11-04T00:00:00.000Z')
  })

  test('новая строка без id начинается невыплаченной, с галочкой — выплаченной сегодня', () => {
    const rows = expenseRows([{ title: 'Подписка 2', amount: 10 }, { id: null, title: 'Сервис', amount: 5, paid: true }], before, NOW)
    assert.deepEqual(rows.map((r) => [r.id, r.paid, r.paidAt && iso(r.paidAt)]), [[undefined, false, null], [undefined, true, '2026-11-04T00:00:00.000Z']])
  })

  test('чужой id не переносится и не берёт чужую отметку', () => {
    const [row] = expenseRows([{ id: 'other-service-expense', title: 'Кто-то', amount: 1, paid: true }], before, NOW)
    assert.equal(row.id, undefined)
    assert.equal(iso(row.paidAt), '2026-11-04T00:00:00.000Z')
  })

  test('один id дважды: второй раз это уже новая строка', () => {
    const rows = expenseRows([{ id: 'e1', title: 'А', amount: 1 }, { id: 'e1', title: 'Б', amount: 2 }], before, NOW)
    assert.equal(rows[0].id, 'e1')
    assert.equal(rows[1].id, undefined)
    assert.equal(rows[1].paid, false)
  })

  test('убранная из формы строка исчезает вместе с отметкой', () => {
    const rows = expenseRows([{ id: 'e2', title: 'Дизайнер', amount: 30 }], before, NOW)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, 'e2')
  })

  test('при создании услуги id не используется, галочка даёт сегодняшний день, выбранная дата — её', () => {
    const rows = expenseRows([
      { id: 'e1', title: 'Копирайтер', amount: 12.34, paid: true },
      { title: 'Дизайнер', amount: 1, paid: true, paidAt: day('2026-10-02') },
    ], [], NOW)
    assert.deepEqual(rows, [
      { title: 'Копирайтер', amountCents: 1234, paid: true, paidAt: TODAY },
      { title: 'Дизайнер', amountCents: 100, paid: true, paidAt: day('2026-10-02') },
    ])
  })

  test('нет расходов — пустой список', () => {
    assert.deepEqual(expenseRows(undefined), [])
  })
})

describe('устаревшая форма без id и paid не стирает отметки', () => {
  const NOW = new Date('2026-11-04T10:00:00.000Z')
  const PAID_AT = day('2026-10-20')
  const CREATED = new Date('2026-10-01T08:00:00.000Z')
  const stored = (id, title, amountCents, paid, paidAt = null) => ({ id, title, amountCents, paid, paidAt, createdAt: CREATED })
  const before = [
    stored('e1', 'Копирайтер', 5000, true, PAID_AT),
    stored('e2', 'Дизайнер', 3000, false),
    stored('e3', 'Подписка', 1000, true), // выплачен до появления отметки, без даты
  ]

  test('строка сопоставляется по названию и сумме: отметка, дата и id остаются', () => {
    const rows = expenseRows([
      { title: 'Копирайтер', amount: 50 },
      { title: 'Дизайнер', amount: 30 },
      { title: 'Подписка', amount: 10 },
    ], before, NOW)
    assert.deepEqual(rows.map((r) => [r.id, r.paid, r.paidAt]), [['e1', true, PAID_AT], ['e2', false, null], ['e3', true, null]])
    assert.equal(rows[0].createdAt, CREATED)
  })

  test('порядок строк в запросе не важен, пробелы по краям названия тоже', () => {
    const rows = expenseRows([{ title: '  Подписка ', amount: 10 }, { title: 'Копирайтер', amount: 50 }], before, NOW)
    assert.deepEqual(rows.map((r) => r.id), ['e3', 'e1'])
  })

  test('сумма изменилась — это уже другая строка, отметки у неё нет', () => {
    const [row] = expenseRows([{ title: 'Копирайтер', amount: 60 }], before, NOW)
    assert.equal(row.id, undefined)
    assert.equal(row.paid, false)
    assert.equal(row.paidAt, null)
  })

  test('название изменилось — тоже другая строка', () => {
    const [row] = expenseRows([{ title: 'Копирайтер Иван', amount: 50 }], before, NOW)
    assert.equal(row.id, undefined)
    assert.equal(row.paid, false)
  })

  test('одинаковые строки забирают одинаковые расходы по очереди, один расход — одной строке', () => {
    const twins = [stored('a', 'Реклама', 100, true, PAID_AT), stored('b', 'Реклама', 100, false)]
    const rows = expenseRows([
      { title: 'Реклама', amount: 1 }, { title: 'Реклама', amount: 1 }, { title: 'Реклама', amount: 1 },
    ], twins, NOW)
    assert.deepEqual(rows.map((r) => [r.id, r.paid]), [['a', true], ['b', false], [undefined, false]])
  })

  test('строка со своим id не теряет расход из-за похожей строки без id выше неё', () => {
    const rows = expenseRows([
      { title: 'Копирайтер', amount: 50 },
      { id: 'e1', title: 'Копирайтер', amount: 50, paid: true },
    ], before, NOW)
    assert.equal(rows[1].id, 'e1')
    assert.equal(rows[1].paidAt, PAID_AT)
    assert.equal(rows[0].id, undefined)
    assert.equal(rows[0].paid, false)
  })

  test('строки новой формы не ищутся по паре: с paid без id это новый расход', () => {
    const [row] = expenseRows([{ title: 'Копирайтер', amount: 50, paid: false }], before, NOW)
    assert.equal(row.id, undefined)
    assert.equal(row.paid, false)
  })

  test('чужой id тоже не повод искать по паре', () => {
    const [row] = expenseRows([{ id: 'чужой', title: 'Копирайтер', amount: 50 }], before, NOW)
    assert.equal(row.id, undefined)
    assert.equal(row.paid, false)
  })

  test('сумма сравнивается в центах, без плавающей точки', () => {
    const [row] = expenseRows([{ title: 'Копирайтер', amount: 50.0000001 }], before, NOW)
    assert.equal(row.id, 'e1')
    const cents = [stored('c', 'Копейки', 1010, true, PAID_AT)]
    assert.equal(expenseRows([{ title: 'Копейки', amount: 10.1 }], cents, NOW)[0].id, 'c')
  })
})

describe('доска целиком', () => {
  const NOW = new Date('2026-11-04T09:00:00.000Z')
  const expense = (amountCents, paid = false) => ({ amountCents, paid })

  /** Карточка в том виде, в каком её читает сервис из базы. */
  function card(name, { status = 'active', startedAt = '2026-01-10', leftAt = null, services = [] } = {}) {
    return {
      id: `card-${name}`,
      clientId: `client-${name}`,
      client: { id: `client-${name}`, name },
      contact: null,
      status,
      startedAt: day(startedAt),
      leftAt: leftAt && day(leftAt),
      leftReason: leftAt ? 'причина' : null,
      services,
      _count: { services: services.length },
    }
  }

  const cards = [
    // Октябрьская услуга, срок работ до середины ноября: в ноябре клиента из-за этого нет.
    card('Альфа', { services: [service('2026-10', { revenueCents: 100000, workTo: '2026-11-15', expenses: [expense(20000, true), expense(5000)] })] }),
    // Пришёл в ноябре.
    card('Бета', { startedAt: '2026-11-02', services: [service('2026-11', { revenueCents: 40000, expenses: [expense(1000)] })] }),
    // Ушёл в октябре, услуги были в сентябре.
    card('Гамма', { status: 'left', startedAt: '2026-05-01', leftAt: '2026-10-20', services: [service('2026-09', { revenueCents: 30000 })] }),
    // Без единой услуги, пришёл в ноябре: виден только в ноябре, пока нет услуг.
    card('Дельта', { startedAt: '2026-11-03' }),
  ]

  const names = (list) => list.map((c) => c.client.name)

  test('в октябре только клиент с услугой октября и ушедший в октябре', () => {
    const board = buildBoard(cards, month('2026-10'), NOW)
    assert.deepEqual(names(board.active), ['Альфа'])
    assert.deepEqual(names(board.left), ['Гамма'])
    assert.equal(board.summary.activeCount, 1)
    assert.equal(board.summary.leftCount, 1)
  })

  test('в ноябре клиент с услугой ноября и новый без услуг, срок работ Альфы не в счёт', () => {
    const board = buildBoard(cards, month('2026-11'), NOW)
    assert.deepEqual(names(board.active), ['Бета', 'Дельта'])
    assert.deepEqual(names(board.left), [])
    const beta = board.active[0]
    assert.equal(beta.serviceCountInPeriod, 1)
    assert.equal(beta.serviceCountTotal, 1)
    assert.equal(board.summary.revenueCents, 40000)
    assert.equal(board.summary.expenseCents, 1000)
    assert.equal(board.summary.unpaidCents, 1000)
    assert.equal(board.summary.profitCents, 39000)
  })

  test('срок работ любой длины не меняет доску', () => {
    const plain = [card('Альфа', { services: [service('2026-10')] })]
    const withSpan = [card('Альфа', { services: [service('2026-10', { workFrom: '2026-09-01', workTo: '2027-06-30' })] })]
    for (const key of ['2026-08', '2026-09', '2026-10', '2026-11', '2027-03']) {
      assert.deepEqual(
        buildBoard(withSpan, month(key), NOW).summary,
        buildBoard(plain, month(key), NOW).summary,
      )
      assert.equal(buildBoard(withSpan, month(key), NOW).active.length, key === '2026-10' ? 1 : 0)
    }
  })

  test('октябрь: деньги Альфы и «не выплачено» по ней', () => {
    const board = buildBoard(cards, month('2026-10'), NOW)
    assert.equal(board.active[0].revenueCents, 100000)
    assert.equal(board.active[0].unpaidCents, 5000)
    assert.equal(board.summary.revenueCents, 100000)
  })

  test('за всё время все карточки на доске, колонки по статусу, итоги по всему', () => {
    const board = buildBoard(cards, null, NOW)
    assert.deepEqual(names(board.active), ['Альфа', 'Бета', 'Дельта'])
    assert.deepEqual(names(board.left), ['Гамма'])
    assert.equal(board.summary.revenueCents, 170000)
  })

  test('список клиентов доски полный, даже когда карточка в этом месяце скрыта', () => {
    // В октябре не видны Бета и Дельта (услуг октября нет), но на доске они есть.
    const board = buildBoard(cards, month('2026-10'), NOW)
    assert.deepEqual(names([...board.active, ...board.left]), ['Альфа', 'Гамма'])
    assert.deepEqual(board.summary.onBoardClientIds, ['client-Альфа', 'client-Бета', 'client-Гамма', 'client-Дельта'])
    // Те же идентификаторы, по которым фронт сравнивает client.id карточек.
    for (const c of [...board.active, ...board.left]) assert.ok(board.summary.onBoardClientIds.includes(c.client.id))
  })

  test('за всё время и в другом месяце список тот же', () => {
    const all = buildBoard(cards, null, NOW).summary.onBoardClientIds
    assert.deepEqual(buildBoard(cards, month('2027-05'), NOW).summary.onBoardClientIds, all)
    assert.equal(all.length, 4)
  })

  test('на пустой доске список пустой', () => {
    assert.deepEqual(buildBoard([], month('2026-10'), NOW).summary.onBoardClientIds, [])
  })

  test('дней с нами: у работающего до сегодня, у ушедшего до дня ухода', () => {
    assert.equal(daysWithUs({ startedAt: day('2026-11-01'), leftAt: null }, NOW), 3)
    assert.equal(daysWithUs({ startedAt: day('2026-10-01'), leftAt: day('2026-10-11') }, NOW), 10)
    assert.equal(daysWithUs({ startedAt: day('2026-11-10'), leftAt: null }, NOW), 0)
  })
})
