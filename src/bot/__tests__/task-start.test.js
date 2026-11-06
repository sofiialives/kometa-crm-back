import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { prisma } from '../../config/prisma.js'
import { lateForTask, reportTaskLate, startGroups, startText, taskButtons, tickTaskStarts } from '../agent/tasks.js'
import { peek } from '../agent/state.js'
import { botHarness } from './harness.js'
import { patch } from './patch.js'

const T = (time) => new Date(`2026-11-03T${time}:00+03:00`)
const task = (id, start, ownerId = 'u1') => ({ id, ownerId, startAt: T(start), title: `Задача ${id}` })

describe('за 5 минут до начала', () => {
  test('одно сообщение на человека и время, со всеми задачами', () => {
    const groups = startGroups([task('a', '12:00'), task('b', '12:00'), task('c', '13:00'), task('d', '12:00', 'u2')])
    assert.deepEqual(groups.map((g) => [g.ownerId, g.tasks.map((t) => t.id).join('')]), [['u1', 'ab'], ['u1', 'c'], ['u2', 'd']])
    const text = startText(groups[0])
    assert.match(text, /Через 5 минут, в <b>12:00<\/b>, начинаются задачи\n«Задача a»\n«Задача b»\n/)
    assert.doesNotMatch(text, /[•:]\s|!/)
  })

  test('кнопка «Беру» на каждую задачу до пяти и одна «Не успеваю»', () => {
    const tasks = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => task(id, '12:00'))
    const rows = taskButtons(tasks)
    assert.equal(rows.length, 6)
    assert.deepEqual(rows.slice(0, 5).map((r) => r[0].data), ['a', 'b', 'c', 'd', 'e'].map((id) => `tk:go:${id}`))
    assert.deepEqual(rows[5].map((b) => b.text), ['Не успеваю'])
    assert.deepEqual(taskButtons([task('a', '12:00')]).map((r) => r[0].text), ['Беру в работу', 'Не успеваю'])
  })

  test('одна задача — текст про одну', () => {
    assert.match(startText(startGroups([task('a', '12:00')])[0]), /начинается «Задача a»/)
  })
})

describe('«Не успеваю» на несколько задач', () => {
  const user = { id: 'u1', name: 'Антон' }

  test('выборка и события ограничены пятью, Яну названия и «и ещё N»', async (t) => {
    const h = botHarness(t)
    const taken = []
    patch(t, prisma.task, 'findUnique', async () => ({ id: 't0', title: 'Задача 0', ownerId: 'u1', status: 'today', startAt: T('12:00') }))
    patch(t, prisma.task, 'count', async () => 9)
    patch(t, prisma.task, 'findMany', async (q) => {
      if (q.where.id) return q.where.id.in.slice(0, q.take).map((id) => ({ id, title: `Задача ${id}`, startAt: T('12:00') }))
      taken.push(q.take)
      return Array.from({ length: q.take }, (_, i) => ({ id: `t${i}` }))
    })
    const events = []
    patch(t, prisma.botEvent, 'create', async ({ data }) => { events.push(data); return data })
    patch(t, prisma.user, 'findMany', async () => [{ id: 'owner' }])
    patch(t, prisma.telegramLink, 'findFirst', async ({ where }) => ({ chatId: `chat-${where.userId}` }))

    await lateForTask(user, 't0')
    assert.deepEqual(taken, [5])
    const state = peek('u1')
    assert.equal(state.payload.taskIds.length, 5)
    assert.equal(state.payload.total, 9)

    await reportTaskLate(user, 't0', 'Застрял на правках', new Date(), state.payload.taskIds, state.payload.total)
    assert.equal(events.length, 5)
    const toOwner = h.sent.find((m) => m.text.includes('Не успевает начать задачи'))
    assert.ok(toOwner)
    assert.equal((toOwner.text.match(/«Задача/g) ?? []).length, 5)
    assert.match(toOwner.text, /\nи ещё 4\n/)
  })
})

describe('напоминание не теряется, если проход пропустили', () => {
  test('окно — все оставшиеся 5 минут, а не одна минута; текст «скоро», если осталось меньше', async (t) => {
    const h = botHarness(t)
    const seen = []
    patch(t, prisma.task, 'findMany', async (q) => { seen.push(q.where.startAt); return [task('a', '12:03')] })
    patch(t, prisma.motivationAway, 'findFirst', async () => null)
    await tickTaskStarts(T('12:00'))
    assert.equal(seen[0].gt.getTime(), T('12:00').getTime())
    assert.equal(seen[0].lte.getTime(), T('12:05').getTime())
    assert.match(h.sent[0].text, /^Скоро, в <b>12:03<\/b>/)
    assert.match(startText({ startAt: T('12:05'), tasks: [task('a', '12:05')] }, T('12:00')), /^Через 5 минут/)
  })
})
