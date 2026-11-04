import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { addClientSchema, addServiceSchema, editServiceSchema, expensePaidSchema } from '../board.schema.js'

const BASE = { boardClientId: 'client1', title: 'Ведение канала', month: '2026-11-01', revenue: 500 }

const add = (extra) => addServiceSchema.safeParse({ body: { ...BASE, ...extra } })
const edit = (body) => editServiceSchema.safeParse({ params: { id: 'service1' }, body })

describe('срок работ при создании услуги', () => {
  test('срока нет — можно, это весь месяц', () => {
    assert.equal(add({}).success, true)
  })

  test('обе границы — принимаются и становятся датами', () => {
    const r = add({ workFrom: '2026-11-05', workTo: '2026-12-10' })
    assert.equal(r.success, true)
    assert.equal(r.data.body.workFrom.toISOString(), '2026-11-05T00:00:00.000Z')
    assert.equal(r.data.body.workTo.toISOString(), '2026-12-10T00:00:00.000Z')
  })

  test('одна граница — можно, вторая возьмётся из месяца', () => {
    assert.equal(add({ workFrom: '2026-11-05' }).success, true)
    assert.equal(add({ workTo: '2026-12-10' }).success, true)
  })

  test('пустая строка — как будто границы нет, null принимается', () => {
    const r = add({ workFrom: '', workTo: null })
    assert.equal(r.success, true)
    assert.equal(r.data.body.workFrom, undefined)
    assert.equal(r.data.body.workTo, null)
  })

  test('один день — можно', () => {
    assert.equal(add({ workFrom: '2026-11-05', workTo: '2026-11-05' }).success, true)
  })

  test('начало позже конца — отказ с понятным сообщением', () => {
    const r = add({ workFrom: '2026-11-10', workTo: '2026-11-09' })
    assert.equal(r.success, false)
    assert.equal(r.error.issues[0].message, 'Срок работ: начало позже конца')
    assert.deepEqual(r.error.issues[0].path, ['body', 'workTo'])
  })

  test('длиннее 366 дней — отказ', () => {
    const r = add({ workFrom: '2026-01-01', workTo: '2027-01-02' })
    assert.equal(r.success, false)
    assert.match(r.error.issues[0].message, /366/)
    assert.equal(add({ workFrom: '2026-01-01', workTo: '2027-01-01' }).success, true)
  })

  test('не дата — отказ', () => {
    assert.equal(add({ workFrom: 'вчера' }).success, false)
  })
})

describe('срок работ при правке услуги', () => {
  test('null сбрасывает границу', () => {
    const r = edit({ workFrom: null, workTo: null })
    assert.equal(r.success, true)
    assert.equal(r.data.body.workFrom, null)
    assert.equal(r.data.body.workTo, null)
  })

  test('правка только срока — это не пустое тело', () => {
    assert.equal(edit({ workTo: '2026-12-01' }).success, true)
    assert.equal(edit({}).success, false)
  })

  test('начало позже конца — отказ', () => {
    assert.equal(edit({ workFrom: '2026-12-02', workTo: '2026-12-01' }).success, false)
  })
})

describe('срок работ у услуг в форме нового клиента', () => {
  const addClient = (service) => addClientSchema.safeParse({
    body: { clientName: 'Ozon', services: [{ title: 'SEO', month: '2026-11-01', revenue: 100, ...service }] },
  })

  test('принимается', () => {
    assert.equal(addClient({ workFrom: '2026-11-03', workTo: '2026-11-20' }).success, true)
  })

  test('начало позже конца — отказ', () => {
    assert.equal(addClient({ workFrom: '2026-11-21', workTo: '2026-11-20' }).success, false)
  })
})

describe('расходы услуги', () => {
  const expenseOf = (expense) => edit({ expenses: [{ title: 'Копирайтер', amount: 50, ...expense }] })

  test('id и paid необязательные', () => {
    assert.equal(expenseOf({}).success, true)
    const r = expenseOf({ id: 'cmt1ik0w80001ijqro3uumtss', paid: true })
    assert.equal(r.success, true)
    assert.equal(r.data.body.expenses[0].id, 'cmt1ik0w80001ijqro3uumtss')
    assert.equal(r.data.body.expenses[0].paid, true)
  })

  test('у новой строки id пустой или null', () => {
    assert.equal(expenseOf({ id: null }).success, true)
    assert.equal(expenseOf({ id: '' }).success, true)
  })

  test('paid — только булево значение', () => {
    assert.equal(expenseOf({ paid: 'да' }).success, false)
    assert.equal(expenseOf({ paid: null }).success, false)
  })

  test('id с недопустимыми символами — отказ', () => {
    assert.equal(expenseOf({ id: 'не id!' }).success, false)
  })

  test('дата выплаты принимается вместе с paid: true, null и пустая строка — как «не выбрана»', () => {
    const r = expenseOf({ paid: true, paidAt: '2026-11-02' })
    assert.equal(r.success, true)
    assert.equal(r.data.body.expenses[0].paidAt.toISOString(), '2026-11-02T00:00:00.000Z')
    assert.equal(expenseOf({ paid: true, paidAt: null }).success, true)
    assert.equal(expenseOf({ paid: false, paidAt: null }).success, true)
    assert.equal(expenseOf({ paid: true, paidAt: '' }).success, true)
  })

  test('дата выплаты без paid: true — отказ с пояснением', () => {
    for (const extra of [{ paidAt: '2026-11-02' }, { paid: false, paidAt: '2026-11-02' }]) {
      const r = expenseOf(extra)
      assert.equal(r.success, false)
      assert.equal(r.error.issues[0].message, 'Дата выплаты указывается только вместе с paid: true')
    }
  })

  test('дата выплаты — не дата: отказ', () => {
    assert.equal(expenseOf({ paid: true, paidAt: 'вчера' }).success, false)
  })

  test('те же поля принимаются при создании услуги', () => {
    assert.equal(add({ expenses: [{ title: 'Подписка', amount: 10, paid: false }] }).success, true)
  })
})

describe('галочка «выплачено» у расхода', () => {
  const mark = (body, id = 'expense1') => expensePaidSchema.safeParse({ params: { id }, body })

  test('true и false принимаются', () => {
    assert.equal(mark({ paid: true }).success, true)
    assert.equal(mark({ paid: false }).success, true)
  })

  test('дату выплаты можно выбрать или оставить пустой', () => {
    const r = mark({ paid: true, paidAt: '2026-11-02' })
    assert.equal(r.success, true)
    assert.equal(r.data.body.paidAt.toISOString(), '2026-11-02T00:00:00.000Z')
    assert.equal(mark({ paid: true, paidAt: null }).success, true)
    assert.equal(mark({ paid: false, paidAt: null }).success, true)
  })

  test('дата при снятой галочке — отказ', () => {
    assert.equal(mark({ paid: false, paidAt: '2026-11-02' }).success, false)
  })

  test('строка, число и пустое тело — отказ', () => {
    assert.equal(mark({ paid: 'false' }).success, false)
    assert.equal(mark({ paid: 1 }).success, false)
    assert.equal(mark({}).success, false)
  })

  test('id с недопустимыми символами — отказ', () => {
    assert.equal(mark({ paid: true }, 'плохой id').success, false)
  })
})

describe('границы сумм', () => {
  test('21 000 000 долларов ещё можно, больше — нельзя', () => {
    assert.equal(add({ revenue: 21_000_000 }).success, true)
    const r = add({ revenue: 21_000_001 })
    assert.equal(r.success, false)
    assert.match(r.error.issues[0].message, /больше 21 000 000/)
  })

  test('максимальная сумма в центах помещается в четырёхбайтовое целое', () => {
    assert.ok(21_000_000 * 100 <= 2_147_483_647)
  })

  test('то же для расхода и для правки услуги', () => {
    assert.equal(edit({ revenue: 25_000_000 }).success, false)
    assert.equal(edit({ expenses: [{ title: 'Реклама', amount: 25_000_000 }] }).success, false)
    assert.equal(edit({ expenses: [{ title: 'Реклама', amount: 21_000_000 }] }).success, true)
  })

  test('отрицательная сумма и не число — отказ с русским сообщением', () => {
    const negative = add({ revenue: -1 })
    assert.equal(negative.success, false)
    assert.equal(negative.error.issues[0].message, 'Сумма не может быть отрицательной')
    const text = add({ revenue: 'много' })
    assert.equal(text.success, false)
    assert.equal(text.error.issues[0].message, 'Сумма должна быть числом')
  })
})

describe('границы дат: от 2000 до 2100 года', () => {
  const refused = (r, path) => {
    assert.equal(r.success, false)
    assert.equal(r.error.issues[0].message, 'Дата должна быть между 2000 и 2100 годом')
    if (path) assert.deepEqual(r.error.issues[0].path, path)
  }

  test('края диапазона проходят', () => {
    assert.equal(add({ month: '2000-01-01' }).success, true)
    assert.equal(add({ month: '2100-12-01', workTo: '2100-12-31' }).success, true)
  })

  test('месяц услуги вне диапазона — отказ', () => {
    refused(add({ month: '1999-12-01' }), ['body', 'month'])
    refused(add({ month: '2101-01-01' }), ['body', 'month'])
    refused(add({ month: '0026-11-01' }), ['body', 'month'])
    refused(edit({ month: '2101-01-01' }), ['body', 'month'])
  })

  test('срок работ вне диапазона — отказ', () => {
    refused(add({ workFrom: '1999-12-31' }), ['body', 'workFrom'])
    refused(add({ workTo: '2101-01-01' }), ['body', 'workTo'])
    refused(edit({ workFrom: '1900-01-01' }), ['body', 'workFrom'])
  })

  test('день оплаты услуги вне диапазона — отказ', () => {
    refused(add({ paidAt: '2101-05-05' }), ['body', 'paidAt'])
    refused(edit({ paidAt: '1999-05-05' }), ['body', 'paidAt'])
  })

  test('день выплаты расхода вне диапазона — отказ', () => {
    refused(edit({ expenses: [{ title: 'Реклама', amount: 1, paid: true, paidAt: '2101-01-01' }] }))
    refused(expensePaidSchema.safeParse({ params: { id: 'e1' }, body: { paid: true, paidAt: '1999-01-01' } }), ['body', 'paidAt'])
  })

  test('в форме нового клиента те же границы', () => {
    const r = addClientSchema.safeParse({
      body: { clientName: 'Ozon', services: [{ title: 'SEO', month: '2101-01-01', revenue: 1 }] },
    })
    refused(r, ['body', 'services', 0, 'month'])
  })

  test('null и пустая строка границу не нарушают', () => {
    assert.equal(edit({ workFrom: null, workTo: '' }).success, true)
  })

  test('не дата — понятное сообщение вместо английского', () => {
    const r = add({ workFrom: 'вчера' })
    assert.equal(r.success, false)
    assert.equal(r.error.issues[0].message, 'Некорректная дата')
  })
})
