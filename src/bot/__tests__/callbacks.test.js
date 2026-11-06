import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { prisma } from '../../config/prisma.js'
import { onCallback } from '../agent/router.js'
import { botHarness } from './harness.js'
import { patch } from './patch.js'

const staff = { id: 'u1', name: 'Антон', role: 'staff', active: true }
const yan = { id: 'yan', name: 'Ян', role: 'admin', active: true }
const now = new Date()
const cb = (data, rows, { date = Math.floor(now.getTime() / 1000) } = {}) => ({
  id: 'cb1',
  data,
  message: {
    message_id: 7, date, text: 'Через 5 минут, в 12:00, начинаются задачи', chat: { id: 1001 },
    reply_markup: { inline_keyboard: rows.map((r) => r.map(([text, callback_data]) => ({ text, callback_data }))) },
  },
})

/** Подмена того, что читает onCallback: счётчик нажатий и состояние задач (уже в процессе — сервис не нужен). */
function setup(t) {
  const h = botHarness(t)
  patch(t, prisma.botMessage, 'count', async () => 0)
  patch(t, prisma.task, 'findUnique', async ({ where }) => ({ id: where.id, title: `Задача ${where.id}`, status: 'progress', ownerId: 'u1' }))
  return h
}

describe('кнопки «Беру» и «Не успеваю»', () => {
  test('«Беру» на одной из двух задач оставляет вторую «Беру» и «Не успеваю»', async (t) => {
    const h = setup(t)
    await onCallback(cb('tk:go:a', [[['Беру A', 'tk:go:a']], [['Беру B', 'tk:go:b']], [['Не успеваю', 'tk:late:a']]]), staff, now)
    assert.equal(h.edits.length, 1)
    assert.deepEqual(h.edits[0].buttons.flat().map((b) => b.callback_data), ['tk:go:b', 'tk:late:a'])
    assert.match(h.edits[0].text, /Задача a/)
  })

  test('последняя «Беру» убирает все кнопки, в том числе «Не успеваю»', async (t) => {
    const h = setup(t)
    await onCallback(cb('tk:go:b', [[['Беру B', 'tk:go:b']], [['Не успеваю', 'tk:late:a']]]), staff, now)
    assert.equal(h.edits.length, 1)
    assert.equal(h.edits[0].buttons, undefined)
  })

  test('«Не успеваю» убирает все кнопки', async (t) => {
    const h = setup(t)
    patch(t, prisma.task, 'findMany', async () => [])
    await onCallback(cb('tk:late:a', [[['Беру A', 'tk:go:a']], [['Не успеваю', 'tk:late:a']]]), staff, now)
    assert.equal(h.edits[0].buttons, undefined)
  })
})

describe('кнопка «Запомнить для всех»', () => {
  const pending = { id: 'n1', userId: null, createdById: 'yan', createdAt: now, approvedAt: null, removedAt: null }
  const rows = [[['Да', 'sn:y:n1'], ['Нет', 'sn:n:n1']]]

  test('владелец жмёт «Да» — записано', async (t) => {
    const h = setup(t)
    patch(t, prisma.botStyleNote, 'findUnique', async () => pending)
    patch(t, prisma, '$transaction', async (fn) => fn(prisma))
    patch(t, prisma, '$executeRaw', async () => 0)
    patch(t, prisma.botStyleNote, 'count', async () => 0)
    const writes = patch(t, prisma.botStyleNote, 'updateMany', async () => ({ count: 1 }))
    await onCallback(cb('sn:y:n1', rows), yan, now)
    assert.equal(writes.length, 1)
    assert.ok(writes[0][0].data.approvedAt)
    assert.match(h.edits[0].text, /Запомнил для всех/)
  })

  test('не владелец жмёт «Да» — ничего не записывается', async (t) => {
    const h = setup(t)
    patch(t, prisma.botStyleNote, 'findUnique', async () => pending)
    const writes = patch(t, prisma.botStyleNote, 'updateMany', async () => ({ count: 1 }))
    const updates = patch(t, prisma.botStyleNote, 'update', async () => ({}))
    await onCallback(cb('sn:y:n1', rows), staff, now)
    assert.equal(writes.length + updates.length, 0)
    assert.match(h.edits[0].text, /Это решает владелец/)
  })

  test('кнопка старше трёх часов — ничего не записывается', async (t) => {
    const h = setup(t)
    patch(t, prisma.botStyleNote, 'findUnique', async () => pending)
    const writes = patch(t, prisma.botStyleNote, 'updateMany', async () => ({ count: 1 }))
    const old = Math.floor(now.getTime() / 1000) - 4 * 3600
    await onCallback(cb('sn:y:n1', rows, { date: old }), yan, now)
    assert.equal(writes.length, 0)
    assert.match(h.edits[0].text, /Кнопка устарела/)
  })
})
