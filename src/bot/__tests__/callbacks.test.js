import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { prisma } from '../../config/prisma.js'
import { onCallback, onText } from '../agent/router.js'
import * as state from '../agent/state.js'
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

describe('ответ после «Не успеваю»', () => {
  const user = { id: 'u1', name: 'Антон', role: 'staff', active: true, departmentId: null }
  const now = new Date('2026-11-03T09:00:00Z')

  function setupText(t) {
    const h = botHarness(t)
    patch(t, prisma.botMessage, 'count', async () => 0)
    patch(t, prisma.botCheckinAnswer, 'findFirst', async () => null)
    patch(t, prisma.botRoundTarget, 'findFirst', async () => null)
    patch(t, prisma.user, 'findMany', async () => [{ id: 'owner' }])
    const created = []
    const tx = {
      $executeRaw: async () => 0,
      motivationAway: { findFirst: async () => null, create: async ({ data }) => { created.push(data); return { id: 'aw1', ...data } }, update: async () => ({}) },
    }
    patch(t, prisma, '$transaction', async (fn) => fn(tx))
    patch(t, prisma.motivationAway, 'findFirst', async () => null)
    const late = []
    patch(t, prisma.botEvent, 'create', async ({ data }) => { late.push(data); return data })
    patch(t, prisma.task, 'findMany', async () => [{ id: 'a', title: 'Задача a', startAt: now }])
    patch(t, prisma.user, 'findUnique', async () => ({ id: 'u1', name: 'Антон', role: 'staff', department: null }))
    return { h, created, late }
  }

  test('«Не успеваю», потом «отхожу на 30 минут» даёт отлучку, а не отчёт об опоздании', async (t) => {
    const { h, created, late } = setupText(t)
    state.expect('u1', 'task_late', { taskId: 'a', taskIds: ['a'] })
    await onText(user, 1001, 'отхожу на 30 минут', now)
    assert.equal(created.length, 1)
    assert.equal(created[0].kind, 'break')
    assert.equal(late.length, 0)
    assert.ok(!h.sent.some((m) => /Не успевает/.test(m.text)))
    assert.equal(state.peek('u1'), null, 'ожидание снято')
  })

  test('обычная причина всё так же уходит Яну', async (t) => {
    const { h, late } = setupText(t)
    state.expect('u1', 'task_late', { taskId: 'a', taskIds: ['a'] })
    await onText(user, 1001, 'застрял на правках у клиента', now)
    assert.equal(late.length, 1)
    assert.ok(h.sent.some((m) => /Не успевает начать задачу/.test(m.text)))
  })
})
