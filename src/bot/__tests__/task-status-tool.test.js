import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { prisma } from '../../config/prisma.js'
import { setTaskStatusByTitle } from '../agent/tasks.js'
import { staffTools } from '../ai/tools.js'
import { botHarness } from './harness.js'
import { patch } from './patch.js'

const roman = { id: 'roman', name: 'Роман Котов', role: 'staff', active: true }
const tasks = [
  { id: 't1', ownerId: 'roman', title: 'Макет баннера для Румикс', status: 'today', deadline: new Date('2026-11-11T16:00:00Z') },
  { id: 't2', ownerId: 'roman', title: 'Отчёт по SEO', status: 'progress', deadline: new Date('2026-11-11T16:00:00Z') },
  { id: 't3', ownerId: 'roman', title: 'Отчёт по рекламе', status: 'today', deadline: new Date('2026-11-11T16:00:00Z') },
]

/** Свои незакрытые задачи и смена статуса, как её видит сервис задач. */
function world(t) {
  const h = botHarness(t)
  patch(t, prisma.telegramLink, 'findFirst', async () => ({ chatId: 'chat-roman' }))
  const findMany = patch(t, prisma.task, 'findMany', async ({ where }) => {
    const w = where.AND[1]
    return tasks.filter((x) => x.ownerId === w.ownerId && w.status.in.includes(x.status))
  })
  const updates = []
  patch(t, prisma.task, 'findUnique', async ({ where }) => tasks.find((x) => x.id === where.id) ?? null)
  patch(t, prisma.task, 'update', async ({ where, data }) => { updates.push({ id: where.id, ...data }); return { ...tasks.find((x) => x.id === where.id), ...data } })
  // Баллы и журнал задач здесь не проверяем.
  for (const [model, method] of [['motivationEvent', 'findFirst'], ['motivationEvent', 'findMany'], ['botEvent', 'create']]) {
    if (prisma[model]) patch(t, prisma[model], method, async () => (method === 'findMany' ? [] : null))
  }
  patch(t, prisma, '$transaction', async () => null)
  return { h, updates, findMany }
}

describe('агент отмечает свою задачу', () => {
  test('кусок названия, одна задача: статус меняется, человеку короткий ответ', async (t) => {
    const { h, updates, findMany } = world(t)
    const res = await setTaskStatusByTitle(roman, 'баннер', 'done', 'chat-roman')
    assert.equal(res.ok, true)
    assert.equal(updates[0].id, 't1')
    assert.equal(updates[0].status, 'done')
    assert.match(h.sent.at(-1).text, /Отметил «Макет баннера для Румикс» выполненной/)
    // Только свои задачи.
    assert.equal(findMany[0][0].where.AND[1].ownerId, 'roman')
  })

  test('подходят две: ничего не меняет, агенту список, чтобы переспросил', async (t) => {
    const { updates } = world(t)
    const res = await setTaskStatusByTitle(roman, 'отчёт', 'done')
    assert.equal(res.ok, false)
    assert.equal(updates.length, 0)
    assert.match(res.note, /Подходят несколько/)
    assert.match(res.note, /Отчёт по SEO/)
    assert.match(res.note, /Отчёт по рекламе/)
  })

  test('не нашлась: список открытых, ничего не меняет', async (t) => {
    const { updates } = world(t)
    const res = await setTaskStatusByTitle(roman, 'Pikabu', 'done')
    assert.equal(res.ok, false)
    assert.equal(updates.length, 0)
    assert.match(res.note, /Такой открытой задачи нет/)
  })

  test('«взял в работу» ищет только среди «На сегодня»', async (t) => {
    const { findMany } = world(t)
    await setTaskStatusByTitle(roman, 'отчёт', 'progress')
    assert.deepEqual(findMany[0][0].where.AND[1].status.in, ['today'])
  })

  test('инструмент есть у сотрудника и описан для модели', () => {
    const tool = staffTools({ user: roman, now: new Date() }).find((x) => x.name === 'set_task_status')
    assert.ok(tool)
    assert.deepEqual(tool.input_schema.properties.status.enum, ['done', 'progress'])
  })
})
