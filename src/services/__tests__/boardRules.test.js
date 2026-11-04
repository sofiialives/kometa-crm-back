import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  cardVisible, columnOf, expenseRows, fillWorkSpan, monthsOfService, resolvePaidAt, resolveRange, serviceInPeriod,
  serviceVisible, shapeService, totals, workSpan, workSpanError, workSpanProblem, dayStart,
} from '../boardRules.js'

const iso = (d) => d.toISOString()
const day = (s) => new Date(`${s}T00:00:00.000Z`)
const month = (key) => resolveRange({ mode: 'month', month: day(`${key}-01`) })

/** Услуга месяца key ('2026-10') с необязательным сроком работ и расходами. */
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

describe('срок работ услуги', () => {
  test('пусто — весь месяц услуги', () => {
    const { from, to } = workSpan(service('2026-10'))
    assert.equal(iso(from), '2026-10-01T00:00:00.000Z')
    assert.equal(iso(to), '2026-10-31T00:00:00.000Z')
  })

  test('последний день месяца: февраль високосного года, декабрь', () => {
    assert.equal(iso(workSpan(service('2028-02')).to), '2028-02-29T00:00:00.000Z')
    assert.equal(iso(workSpan(service('2026-02')).to), '2026-02-28T00:00:00.000Z')
    assert.equal(iso(workSpan(service('2026-12')).to), '2026-12-31T00:00:00.000Z')
  })

  test('заданные дни приводятся к полуночи UTC', () => {
    const s = { ...service('2026-10'), workFrom: new Date('2026-10-20T15:30:00.000Z'), workTo: new Date('2026-11-05T23:59:00.000Z') }
    const { from, to } = workSpan(s)
    assert.equal(iso(from), '2026-10-20T00:00:00.000Z')
    assert.equal(iso(to), '2026-11-05T00:00:00.000Z')
  })

  test('задана одна граница — вторая берётся из месяца услуги', () => {
    const onlyFrom = workSpan(service('2026-10', { workFrom: '2026-10-20' }))
    assert.equal(iso(onlyFrom.from), '2026-10-20T00:00:00.000Z')
    assert.equal(iso(onlyFrom.to), '2026-10-31T00:00:00.000Z')
    const onlyTo = workSpan(service('2026-10', { workTo: '2026-11-10' }))
    assert.equal(iso(onlyTo.from), '2026-10-01T00:00:00.000Z')
    assert.equal(iso(onlyTo.to), '2026-11-10T00:00:00.000Z')
  })

  test('в ответе границы всегда заполнены', () => {
    const filled = fillWorkSpan(service('2026-11'))
    assert.equal(iso(filled.workFrom), '2026-11-01T00:00:00.000Z')
    assert.equal(iso(filled.workTo), '2026-11-30T00:00:00.000Z')
    assert.equal(filled.revenueCents, 100000)
  })

  test('начало позже конца — ошибка, один день — можно', () => {
    assert.match(workSpanError(day('2026-11-10'), day('2026-11-09')), /начало позже конца/)
    assert.equal(workSpanError(day('2026-11-10'), day('2026-11-10')), null)
  })

  test('не длиннее 366 дней, считая оба края', () => {
    assert.equal(workSpanError(day('2028-01-01'), day('2028-12-31')), null) // високосный год, 366 дней
    assert.equal(workSpanError(day('2026-01-01'), day('2027-01-01')), null) // 366 дней
    assert.match(workSpanError(day('2026-01-01'), day('2027-01-02')), /366/) // 367 дней
  })

  test('срок проверяется вместе с месяцем услуги, если задана одна граница', () => {
    const nov = day('2026-11-01')
    assert.equal(workSpanProblem({ month: nov, workFrom: null, workTo: null }), null)
    assert.equal(workSpanProblem({ month: nov, workFrom: day('2026-11-10'), workTo: null }), null)
    // Начало в декабре, конца нет: он берётся из ноября, и выходит наоборот.
    assert.match(workSpanProblem({ month: nov, workFrom: day('2026-12-05'), workTo: null }), /начало позже конца.*край месяца/)
    // Конец в октябре, начала нет: начало берётся из ноября.
    assert.match(workSpanProblem({ month: nov, workFrom: null, workTo: day('2026-10-20') }), /начало позже конца/)
  })

  test('обе границы заданы — без пояснения про месяц', () => {
    const problem = workSpanProblem({ month: day('2026-11-01'), workFrom: day('2026-11-10'), workTo: day('2026-11-02') })
    assert.equal(problem, 'Срок работ: начало позже конца')
  })

  test('слишком длинный срок через месяц услуги', () => {
    // Конец через два года после месяца услуги: начало берётся из месяца.
    assert.match(workSpanProblem({ month: day('2026-11-01'), workFrom: null, workTo: day('2028-12-01') }), /366/)
  })

  test('день — это полночь UTC', () => {
    assert.equal(iso(dayStart('2026-11-04T23:59:59.999Z')), '2026-11-04T00:00:00.000Z')
  })
})

describe('какие услуги видны в периоде', () => {
  test('услуга без срока работ видна только в своём месяце', () => {
    const s = service('2026-10')
    assert.equal(serviceVisible(s, month('2026-10')), true)
    assert.equal(serviceVisible(s, month('2026-09')), false)
    assert.equal(serviceVisible(s, month('2026-11')), false)
  })

  test('доделки: видна в следующем месяце, но не идёт в его итоги', () => {
    const s = service('2026-10', { workFrom: '2026-10-20', workTo: '2026-11-10' })
    assert.equal(serviceVisible(s, month('2026-10')), true)
    assert.equal(serviceInPeriod(s, month('2026-10')), true)
    assert.equal(serviceVisible(s, month('2026-11')), true)
    assert.equal(serviceInPeriod(s, month('2026-11')), false)
    assert.equal(serviceVisible(s, month('2026-12')), false)
  })

  test('последний день срока входит целиком', () => {
    assert.equal(serviceVisible(service('2026-10', { workTo: '2026-11-01' }), month('2026-11')), true)
    assert.equal(serviceVisible(service('2026-10', { workTo: '2026-10-31' }), month('2026-11')), false)
    assert.equal(serviceVisible(service('2026-10', { workFrom: '2026-10-31' }), month('2026-10')), true)
  })

  test('срок целиком в чужом месяце: видна и в своём (по месяцу), и в месяце работ', () => {
    const s = service('2026-10', { workFrom: '2026-11-30', workTo: '2026-12-03' })
    assert.equal(serviceVisible(s, month('2026-10')), true)
    assert.equal(serviceVisible(s, month('2026-11')), true)
    assert.equal(serviceVisible(s, month('2026-12')), true)
    assert.equal(serviceVisible(s, month('2027-01')), false)
  })

  test('срок через несколько месяцев виден во всех промежуточных', () => {
    const s = service('2026-09', { workFrom: '2026-09-25', workTo: '2026-12-05' })
    for (const m of ['2026-09', '2026-10', '2026-11', '2026-12']) assert.equal(serviceVisible(s, month(m)), true, m)
    assert.equal(serviceVisible(s, month('2027-01')), false)
  })

  test('за всё время видно и считается всё', () => {
    const s = service('2026-10', { workFrom: '2026-10-20', workTo: '2026-11-10' })
    assert.equal(serviceVisible(s, null), true)
    assert.equal(serviceInPeriod(s, null), true)
  })

  test('последние месяцы: доделка прошлого месяца видна', () => {
    const now = new Date('2026-11-04T09:00:00.000Z')
    const range = resolveRange({ mode: 'last', months: 1 }, now)
    const s = service('2026-10', { workFrom: '2026-10-20', workTo: '2026-11-10' })
    assert.equal(serviceVisible(s, range), true)
    assert.equal(serviceInPeriod(s, range), false)
  })

  test('последние месяцы: работа, которая начнётся после сегодняшнего дня, ещё не видна', () => {
    const now = new Date('2026-11-04T09:00:00.000Z')
    const range = resolveRange({ mode: 'last', months: 1 }, now)
    assert.equal(serviceVisible(service('2026-10', { workFrom: '2026-11-20', workTo: '2026-11-25' }), range), false)
    assert.equal(serviceVisible(service('2026-10', { workFrom: '2026-11-04', workTo: '2026-11-25' }), range), true)
  })

  test('последние месяцы в первую московскую ночь месяца: услуга нового месяца уже есть', () => {
    // 1 ноября 01:00 по Москве.
    const range = resolveRange({ mode: 'last', months: 1 }, new Date('2026-10-31T22:00:00.000Z'))
    assert.equal(serviceVisible(service('2026-11'), range), true)
    assert.equal(serviceInPeriod(service('2026-11'), range), true)
    assert.equal(serviceVisible(service('2026-10'), range), false)
  })

  test('произвольный период: месяц считается по первому числу, работа — по дням', () => {
    const range = resolveRange({ mode: 'period', from: day('2026-09-15'), to: day('2026-10-10') })
    // Сентябрь: первое число осталось позади, выручка не считается, но услуга
    // работала в сентябре, поэтому видна.
    const september = service('2026-09')
    assert.equal(serviceInPeriod(september, range), false)
    assert.equal(serviceVisible(september, range), true)
    // Октябрь: первое число внутри периода.
    assert.equal(serviceInPeriod(service('2026-10'), range), true)
    // Ноябрь: даже срок работ не доходит.
    assert.equal(serviceVisible(service('2026-11'), range), false)
    // Работа закончилась до начала периода.
    assert.equal(serviceVisible(service('2026-09', { workTo: '2026-09-14' }), range), false)
  })

  test('период с одной границей', () => {
    const since = resolveRange({ mode: 'period', from: day('2026-11-01') })
    assert.equal(serviceVisible(service('2026-12'), since), true)
    assert.equal(serviceVisible(service('2026-10', { workTo: '2026-10-31' }), since), false)
    assert.equal(serviceVisible(service('2026-10', { workTo: '2026-11-01' }), since), true)
    const until = resolveRange({ mode: 'period', to: day('2026-10-31') })
    assert.equal(serviceVisible(service('2026-10'), until), true)
    assert.equal(serviceVisible(service('2026-11'), until), false)
  })

  test('кривой срок, где начало позже конца, ничего не добавляет к своему месяцу', () => {
    const s = service('2026-10', { workFrom: '2026-12-10', workTo: '2026-12-01' })
    assert.equal(serviceVisible(s, month('2026-12')), false)
    assert.equal(serviceVisible(s, month('2026-10')), true)
  })
})

describe('итоги только по услугам своего месяца', () => {
  const paidExpense = { amountCents: 20000, paid: true }
  const openExpense = { amountCents: 5000, paid: false }

  test('доделка из другого месяца не попадает ни в выручку, ни в расходы', () => {
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

  test('услуга в ответе: inPeriod, заполненный срок и свои цифры даже у доделки', () => {
    const s = service('2026-10', { revenueCents: 100000, expenses: [paidExpense, openExpense], workTo: '2026-11-10' })
    const inOctober = shapeService(s, month('2026-10'))
    assert.equal(inOctober.inPeriod, true)
    const inNovember = shapeService(s, month('2026-11'))
    assert.equal(inNovember.inPeriod, false)
    assert.equal(iso(inNovember.workFrom), '2026-10-01T00:00:00.000Z')
    assert.equal(iso(inNovember.workTo), '2026-11-10T00:00:00.000Z')
    assert.equal(inNovember.revenueCents, 100000)
    assert.equal(inNovember.expenseCents, 25000)
    assert.equal(inNovember.unpaidCents, 5000)
    assert.equal(inNovember.profitCents, 75000)
  })
})

describe('какие карточки есть в периоде', () => {
  test('есть видимая услуга — карточка есть', () => {
    const card = { startedAt: day('2026-01-10'), leftAt: null, serviceCount: 3, visibleCount: 1 }
    assert.equal(cardVisible(card, month('2026-11')), true)
  })

  test('услуги заведены, но в период ни одна не попала — карточки нет', () => {
    // Клиент, пришедший в ноябре, не висит в октябре.
    const card = { startedAt: day('2026-11-02'), leftAt: null, serviceCount: 2, visibleCount: 0 }
    assert.equal(cardVisible(card, month('2026-10')), false)
    assert.equal(cardVisible(card, month('2026-12')), false)
  })

  test('без услуг — с месяца начала и дальше', () => {
    const card = { startedAt: day('2026-11-05'), leftAt: null, serviceCount: 0, visibleCount: 0 }
    assert.equal(cardVisible(card, month('2026-10')), false)
    assert.equal(cardVisible(card, month('2026-11')), true)
    assert.equal(cardVisible(card, month('2027-03')), true)
    assert.equal(cardVisible(card, resolveRange({ mode: 'last', months: 3 }, new Date('2026-12-10T10:00:00.000Z'))), true)
  })

  test('без услуг и ушёл — до месяца ухода включительно', () => {
    const card = { startedAt: day('2026-09-10'), leftAt: day('2026-10-10'), serviceCount: 0, visibleCount: 0 }
    assert.equal(cardVisible(card, month('2026-08')), false)
    assert.equal(cardVisible(card, month('2026-09')), true)
    assert.equal(cardVisible(card, month('2026-10')), true)
    assert.equal(cardVisible(card, month('2026-11')), false)
  })

  test('за всё время видны все карточки', () => {
    const card = { startedAt: day('2026-11-05'), leftAt: null, serviceCount: 2, visibleCount: 0 }
    assert.equal(cardVisible(card, null), true)
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

  test('ушёл раньше начала периода, а карточка видна из-за доделок — «Ушедшие»', () => {
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

describe('месяцы для списка выбора', () => {
  const keys = (s) => monthsOfService(s).map((m) => m.toISOString().slice(0, 7)).sort()

  test('без срока работ — только месяц услуги', () => {
    assert.deepEqual(keys(service('2026-10')), ['2026-10'])
  })

  test('срок в другие месяцы — добавляет их все', () => {
    assert.deepEqual(keys(service('2026-10', { workFrom: '2026-10-20', workTo: '2027-01-05' })), ['2026-10', '2026-11', '2026-12', '2027-01'])
  })

  test('месяц услуги остаётся, даже если срок целиком в другом месяце', () => {
    assert.deepEqual(keys(service('2026-10', { workFrom: '2026-12-02', workTo: '2026-12-05' })), ['2026-10', '2026-12'])
  })

  test('кривой срок не ломает список', () => {
    assert.deepEqual(keys(service('2026-10', { workFrom: '2026-12-10', workTo: '2026-12-01' })), ['2026-10'])
  })
})

describe('отметка «выплачено» у расходов', () => {
  const NOW = new Date('2026-11-04T10:00:00.000Z')
  const EARLIER = new Date('2026-10-20T09:00:00.000Z')
  const CREATED = new Date('2026-10-01T08:00:00.000Z')
  // Расходы услуги, как они лежат в базе до правки.
  const before = [
    { id: 'e1', title: 'Копирайтер', amountCents: 5000, paid: true, paidAt: EARLIER, createdAt: CREATED },
    { id: 'e2', title: 'Дизайнер', amountCents: 3000, paid: false, paidAt: null, createdAt: CREATED },
  ]

  test('поставили галочку — дата выплаты сейчас, сняли — пусто', () => {
    assert.equal(resolvePaidAt(null, true, NOW), NOW)
    assert.equal(resolvePaidAt(before[0], false, NOW), null)
    assert.equal(resolvePaidAt(null, false, NOW), null)
  })

  test('уже выплаченный остаётся с прежней датой', () => {
    assert.equal(resolvePaidAt(before[0], true, NOW), EARLIER)
  })

  test('невыплаченный, которому ставят галочку, получает сегодняшнюю дату', () => {
    assert.equal(resolvePaidAt(before[1], true, NOW), NOW)
  })

  test('выплаченный без даты (так быть не должно) получает дату сейчас', () => {
    assert.equal(resolvePaidAt({ paid: true, paidAt: null }, true, NOW), NOW)
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

  test('если форма про галочку не знает, отметка остаётся как была', () => {
    const rows = expenseRows([{ id: 'e1', title: 'Копирайтер', amount: 50 }, { id: 'e2', title: 'Дизайнер', amount: 30 }], before, NOW)
    assert.deepEqual(rows.map((r) => [r.paid, r.paidAt]), [[true, EARLIER], [false, null]])
  })

  test('галочку снимают — дата стирается', () => {
    const [row] = expenseRows([{ id: 'e1', title: 'Копирайтер', amount: 50, paid: false }], before, NOW)
    assert.equal(row.paid, false)
    assert.equal(row.paidAt, null)
  })

  test('галочку ставят у прежнего расхода — дата выплаты сейчас', () => {
    const [row] = expenseRows([{ id: 'e2', title: 'Дизайнер', amount: 30, paid: true }], before, NOW)
    assert.equal(row.paid, true)
    assert.equal(row.paidAt, NOW)
  })

  test('новая строка без id начинается невыплаченной, с галочкой — выплаченной сегодня', () => {
    const rows = expenseRows([{ title: 'Подписка', amount: 10 }, { id: null, title: 'Сервис', amount: 5, paid: true }], before, NOW)
    assert.deepEqual(rows.map((r) => [r.id, r.paid, r.paidAt]), [[undefined, false, null], [undefined, true, NOW]])
  })

  test('чужой id не переносится и не берёт чужую отметку', () => {
    const [row] = expenseRows([{ id: 'other-service-expense', title: 'Кто-то', amount: 1, paid: true }], before, NOW)
    assert.equal(row.id, undefined)
    assert.equal(row.paidAt, NOW)
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

  test('при создании услуги id не используется, галочка даёт сегодняшнюю дату', () => {
    const rows = expenseRows([{ id: 'e1', title: 'Копирайтер', amount: 12.34, paid: true }], [], NOW)
    assert.deepEqual(rows, [{ title: 'Копирайтер', amountCents: 1234, paid: true, paidAt: NOW }])
  })

  test('нет расходов — пустой список', () => {
    assert.deepEqual(expenseRows(undefined), [])
  })
})
