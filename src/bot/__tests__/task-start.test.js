import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { startGroups, startText, taskButtons } from '../agent/tasks.js'

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
