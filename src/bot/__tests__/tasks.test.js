import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { excusedByLate, notStartedGroups } from '../agent/tasks.js'

const T = (time) => new Date(`2026-11-03T${time}:00+03:00`)

describe('задача не начата вовремя', () => {
  test('пять задач на одно время — одно сообщение', () => {
    const task = (id, start, ownerId = 'u1') => ({ id, ownerId, startAt: T(start), createdAt: T('09:00'), title: id })
    const groups = notStartedGroups([task('a', '10:00'), task('b', '10:00'), task('c', '10:00'), task('d', '11:00'), task('e', '10:00', 'u2')])
    assert.deepEqual(groups.map((g) => [g.ownerId, g.tasks.map((t) => t.id).join('')]), [['u1', 'abc'], ['u1', 'd'], ['u2', 'e']])
  })

  test('задачу завели после начала — не отчитываемся', () => {
    const groups = notStartedGroups([{ id: 'a', ownerId: 'u1', startAt: T('14:00'), createdAt: T('14:15'), title: 'a' }])
    assert.equal(groups.length, 0)
  })

  test('«задерживаюсь до 11:30» — до 11:45 молчим', () => {
    const lates = [{ at: T('10:50'), data: { until: T('11:30').toISOString() } }]
    assert.equal(excusedByLate(lates, T('11:20')), true)
    assert.equal(excusedByLate(lates, T('11:44')), true)
    assert.equal(excusedByLate(lates, T('11:46')), false)
  })

  test('«опаздываю» без времени — три часа', () => {
    const lates = [{ at: T('10:00'), data: null }]
    assert.equal(excusedByLate(lates, T('12:30')), true)
    assert.equal(excusedByLate(lates, T('13:30')), false)
    assert.equal(excusedByLate([], T('12:00')), false)
  })
})
