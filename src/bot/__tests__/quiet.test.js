import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { prisma } from '../../config/prisma.js'
import { eveningOpenTasks, eveningText } from '../agent/tasks.js'
import { dueTodayWhere } from '../agent/taskScope.js'
import { DAILY } from '../index.js'
import { botHarness } from './harness.js'
import { patch } from './patch.js'

// Вторник, 18:00 по Москве.
const EVENING = new Date('2026-11-03T15:00:00Z')

describe('18:00 только с незакрытыми задачами', () => {
  test('текст: названия в ёлочках, до пяти, остальные «и ещё N», без точек, двоеточий и маркеров', () => {
    const text = eveningText('Антон Иванов', ['Макет', 'Баннер'], 2)
    assert.equal(text, 'Антон, через час звонок\nОсталось закрыть\n«Макет»\n«Баннер»')
    const long = eveningText('Антон', ['a', 'b', 'c', 'd', 'e'], 8)
    assert.ok(long.endsWith('«e»\nи ещё 3'))
    assert.doesNotMatch(long, /[.:!•]/)
  })

  test('условие: не сделана, срок сегодня, даже если час уже прошёл', () => {
    const where = dueTodayWhere(EVENING)
    assert.deepEqual(where.status, { in: ['today', 'progress'] })
    assert.equal(where.deadline.gte.toISOString(), '2026-11-02T21:00:00.000Z')
    assert.equal(where.deadline.lt.toISOString(), '2026-11-03T21:00:00.000Z')
  })

  test('пишем только тем, у кого есть такие задачи, один раз, и сообщение попадает в журнал', async (t) => {
    const h = botHarness(t)
    // Запрос людей уже отфильтрован базой по «есть незакрытые задачи сегодня».
    const filter = []
    patch(t, prisma.user, 'findMany', async (q) => { filter.push(q.where); return [{ id: 'u1', name: 'Антон Иванов' }] })
    patch(t, prisma.motivationAway, 'findFirst', async () => null)
    patch(t, prisma.task, 'findMany', async () => [{ title: 'Макет' }, { title: 'Баннер' }])
    patch(t, prisma.task, 'count', async () => 7)
    assert.equal(await eveningOpenTasks(EVENING), 1)
    assert.ok(filter[0].tasks.some, 'в запросе людей есть условие по задачам')
    assert.equal(h.sent.length, 1)
    assert.equal(h.sent[0].text, 'Антон, через час звонок\nОсталось закрыть\n«Макет»\n«Баннер»\nи ещё 5')
    assert.equal(h.logged.length, 1)
    assert.equal(h.logged[0].direction, 'out')
    assert.equal(await eveningOpenTasks(EVENING), 0, 'второй раз тот же вечер не пишем')
  })

  test('в субботу не пишем', async (t) => {
    const h = botHarness(t)
    patch(t, prisma.user, 'findMany', async () => [{ id: 'u1', name: 'Антон' }])
    assert.equal(await eveningOpenTasks(new Date('2026-11-07T15:00:00Z')), 0)
    assert.equal(h.sent.length, 0)
  })

  test('у кого форс-мажор или день закончен — молчим', async (t) => {
    const h = botHarness(t)
    patch(t, prisma.user, 'findMany', async () => [{ id: 'u1', name: 'Антон' }, { id: 'u2', name: 'Олег' }])
    patch(t, prisma.motivationAway, 'findFirst', async ({ where }) => (where.userId === 'u1' ? { kind: 'force_majeure' } : null))
    h.notices.add('dayend:2026-11-03:u2')
    patch(t, prisma.task, 'findMany', async () => [{ title: 'Макет' }])
    patch(t, prisma.task, 'count', async () => 1)
    assert.equal(await eveningOpenTasks(EVENING), 0)
    assert.equal(h.sent.length, 0)
  })
})

describe('расписание одинаковых сообщений', () => {
  test('остался только утренний пинг в 9:40, без смайликов и восклицаний', () => {
    assert.deepEqual(DAILY.map((d) => d.at), ['40 9 * * 1-5'])
    assert.doesNotMatch(DAILY[0].text, /[!.]|[\u{1F300}-\u{1FAFF}]/u)
  })
})
