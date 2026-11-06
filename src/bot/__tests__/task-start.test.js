import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { prisma } from '../../config/prisma.js'
import { lateForTask, reportTaskLate, startGroups, startLead, startText, taskButtons, tickTaskStarts } from '../agent/tasks.js'
import { clear, peek } from '../agent/state.js'
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

  test('извиняет все задачи минуты (до 50), Яну названия до пяти и «и ещё N», подпись «Имя, отдел»', async (t) => {
    const h = botHarness(t)
    const taken = []
    patch(t, prisma.task, 'findUnique', async () => ({ id: 't0', title: 'Задача 0', ownerId: 'u1', status: 'today', startAt: T('12:00') }))
    patch(t, prisma.task, 'findMany', async (q) => {
      if (q.where.id) return q.where.id.in.slice(0, q.take).map((id) => ({ id, title: `Задача ${id}`, startAt: T('12:00') }))
      taken.push([q.take, q.where.startAt])
      return Array.from({ length: 12 }, (_, i) => ({ id: `t${i}` }))
    })
    const events = []
    patch(t, prisma.botEvent, 'create', async ({ data }) => { events.push(data); return data })
    patch(t, prisma.user, 'findMany', async () => [{ id: 'owner' }])
    patch(t, prisma.user, 'findUnique', async () => ({ id: 'u1', name: 'Антон Иванов', role: 'staff', department: { name: 'Дизайн' } }))

    await lateForTask(user, 't0')
    assert.equal(taken[0][0], 50)
    assert.equal(taken[0][1].gte.getTime(), T('12:00').getTime())
    assert.equal(taken[0][1].lt.getTime(), T('12:01').getTime())
    const state = peek('u1')
    assert.equal(state.payload.taskIds.length, 12)

    await reportTaskLate(user, 't0', 'Застрял на правках', new Date(), state.payload.taskIds)
    assert.equal(events.length, 12, 'событие task_late на каждую задачу, иначе за них штраф')
    const toOwner = h.sent.find((m) => m.text.includes('Не успевает начать задачи'))
    assert.equal((toOwner.text.match(/«Задача/g) ?? []).length, 5)
    assert.match(toOwner.text, /\nи ещё 7\n/)
    assert.match(toOwner.text, /<b>Не успевает начать задачи<\/b>\nАнтон, дизайн\n/)
  })
})

describe('«Не успеваю» для уже начатой задачи', () => {
  const user = { id: 'u1', name: 'Антон' }

  test('задача в процессе и других на эту минуту нет: «уже в процессе», вопроса и ожидания нет', async (t) => {
    const h = botHarness(t)
    clear('u1')
    patch(t, prisma.task, 'findUnique', async () => ({ id: 'a', title: 'Задача a', ownerId: 'u1', status: 'progress', startAt: T('12:00') }))
    patch(t, prisma.task, 'findMany', async () => [])
    assert.equal(await lateForTask(user, 'a'), '«Задача a» уже в процессе')
    assert.equal(h.sent.length, 0)
    assert.equal(peek('u1'), null)
  })

  test('первую задачу взял, вторая на ту же минуту не начата: «Не успеваю» про вторую', async (t) => {
    const h = botHarness(t)
    clear('u1')
    patch(t, prisma.task, 'findUnique', async () => ({ id: 'a', title: 'Задача a', ownerId: 'u1', status: 'progress', startAt: T('12:00') }))
    patch(t, prisma.task, 'findMany', async (q) => {
      assert.equal(q.where.status, 'today')
      return [{ id: 'b' }]
    })
    assert.equal(await lateForTask(user, 'a'), 'Не успеваю начать', 'название взятой задачи не показываем')
    assert.match(h.sent.at(-1).text, /Что случилось/)
    assert.deepEqual(peek('u1').payload.taskIds, ['b'])
    assert.equal(peek('u1').payload.taskId, 'b')
    clear('u1')
  })

  test('к моменту ответа задачи уже взяли: событий и отчёта Яну нет; остались не взятые — только они', async (t) => {
    const h = botHarness(t)
    const events = []
    patch(t, prisma.botEvent, 'create', async ({ data }) => { events.push(data); return data })
    patch(t, prisma.user, 'findMany', async () => [{ id: 'owner' }])
    patch(t, prisma.user, 'findUnique', async () => ({ id: 'u1', name: 'Антон', role: 'staff', department: null }))
    patch(t, prisma.task, 'findMany', async (q) => {
      assert.equal(q.where.status, 'today')
      return q.where.id.in.includes('b') ? [{ id: 'b', title: 'Задача b', startAt: T('12:00') }] : []
    })
    await reportTaskLate(user, 'a', 'Застрял', new Date(), ['a'])
    assert.equal(events.length, 0)
    assert.ok(!h.sent.some((m) => m.chatId === 'chat-owner'))
    await reportTaskLate(user, 'a', 'Застрял', new Date(), ['a', 'b'])
    assert.equal(events.length, 1)
    assert.match(h.sent.find((m) => m.chatId === 'chat-owner').text, /«Задача b»/)
    assert.doesNotMatch(h.sent.find((m) => m.chatId === 'chat-owner').text, /Задача a/)
  })
})

describe('группа по минуте начала и ключ на задачу', () => {
  const A = { ...task('a', '12:00'), startAt: new Date(T('12:00').getTime()) }
  const B = { ...task('b', '12:00'), startAt: new Date(T('12:00').getTime() + 30000) }

  test('12:00:00 и 12:00:30 — одно сообщение; второй проход их не повторяет', async (t) => {
    const h = botHarness(t)
    assert.equal(startGroups([A, B]).length, 1)
    patch(t, prisma.motivationAway, 'findFirst', async () => null)
    patch(t, prisma.task, 'findMany', async () => [A, B])
    await tickTaskStarts(T('11:56'))
    await tickTaskStarts(T('11:57'))
    assert.equal(h.sent.length, 1)
    assert.match(h.sent[0].text, /«Задача a»\n«Задача b»/)
    assert.deepEqual([...h.notices].sort(), ['task-start:t:a', 'task-start:t:b'])
  })

  test('в 11:55:10 задача на 12:00:30 попадает в окно: оно до конца минуты', async (t) => {
    botHarness(t)
    const seen = []
    patch(t, prisma.task, 'findMany', async (q) => { seen.push(q.where.startAt); return [] })
    await tickTaskStarts(new Date(T('11:55').getTime() + 10000))
    assert.ok(B.startAt.getTime() > seen[0].gt.getTime() && B.startAt.getTime() < seen[0].lt.getTime())
    assert.equal(seen[0].lt.getTime(), T('12:01').getTime())
  })

  test('задача, заведённая после отправки на ту же минуту, получает своё напоминание', async (t) => {
    const h = botHarness(t)
    patch(t, prisma.motivationAway, 'findFirst', async () => null)
    let list = [A]
    patch(t, prisma.task, 'findMany', async () => list)
    await tickTaskStarts(T('11:56'))
    list = [A, B]
    await tickTaskStarts(T('11:57'))
    assert.equal(h.sent.length, 2)
    assert.match(h.sent[1].text, /«Задача b»/)
    assert.doesNotMatch(h.sent[1].text, /Задача a/)
  })

  test('временный сбой телеграма освобождает ключи, следующий проход повторит', async (t) => {
    const h = botHarness(t)
    patch(t, prisma.motivationAway, 'findFirst', async () => null)
    patch(t, prisma.task, 'findMany', async () => [A])
    const ok = globalThis.fetch
    let fail = true
    globalThis.fetch = async (url, init) => (fail && String(url).endsWith('sendMessage')
      ? new Response(JSON.stringify({ ok: false }), { status: 500 })
      : ok(url, init))
    t.after(() => { globalThis.fetch = ok })
    await tickTaskStarts(T('11:56'))
    assert.equal(h.notices.size, 0)
    fail = false
    await tickTaskStarts(T('11:57'))
    assert.equal(h.sent.length, 1)
  })
})

describe('заголовок напоминания', () => {
  test('«Через 5 минут» только когда реально пять, иначе честно; меньше двух — «Сейчас»', () => {
    const lead = (min) => startLead(T('12:00'), new Date(T('12:00').getTime() - min * 60000))
    assert.equal(lead(5), 'Через 5 минут')
    assert.equal(lead(4), 'Через 4 минуты')
    assert.equal(lead(3), 'Через 3 минуты')
    assert.equal(lead(2), 'Через 2 минуты')
    assert.equal(lead(1), 'Сейчас')
    assert.equal(lead(6), 'Через 5 минут', 'окно до конца минуты не даёт «Через 6 минут»')
    assert.match(startText({ startAt: T('12:00'), tasks: [task('a', '12:00')] }, new Date(T('12:00').getTime() - 30000)), /^Сейчас, в <b>12:00<\/b>, начинается/)
  })
})

describe('тихие часы по времени начала', () => {
  test('задача на 9:00 получает напоминание в 8:55, задача на 21:00 в 20:55 не получает', async (t) => {
    const h = botHarness(t)
    patch(t, prisma.motivationAway, 'findFirst', async () => null)
    patch(t, prisma.task, 'findMany', async () => [task('a', '09:00')])
    await tickTaskStarts(T('08:55'))
    assert.equal(h.sent.length, 1)
    patch(t, prisma.task, 'findMany', async () => [task('b', '21:00', 'u2')])
    await tickTaskStarts(T('20:55'))
    assert.equal(h.sent.length, 1)
  })
})
