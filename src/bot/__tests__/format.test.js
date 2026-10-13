import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { at, duration, endOfDay, hm, points, short } from '../agent/format.js'

describe('как агент пишет время', () => {
  test('часы и минуты по Москве', () => {
    assert.equal(hm(new Date('2026-11-03T13:30:00Z')), '16:30')
  })

  test('не сегодня — с датой', () => {
    const now = new Date('2026-11-03T12:00:00+03:00')
    assert.equal(at(new Date('2026-11-03T16:30:00+03:00'), now), '16:30')
    assert.equal(at(new Date('2026-11-04T10:00:00+03:00'), now), '04.11 в 10:00')
  })

  test('длительность', () => {
    assert.equal(duration(0), 'меньше минуты')
    assert.equal(duration(5), '5 мин')
    assert.equal(duration(60), '1 ч')
    assert.equal(duration(80), '1 ч 20 мин')
  })

  test('конец дня — 23:59 по Москве', () => {
    assert.equal(endOfDay(new Date('2026-11-03T22:30:00Z')).toISOString(), new Date('2026-11-04T23:59:00+03:00').toISOString())
  })

  test('баллы со склонением и знаком', () => {
    assert.equal(points(1), '+1 балл')
    assert.equal(points(-3), '−3 балла')
    assert.equal(points(5), '+5 баллов')
    assert.equal(points(-11), '−11 баллов')
    assert.equal(points(22), '+22 балла')
  })

  test('длинное название обрезается', () => {
    assert.equal(short('а'.repeat(50), 10), `${'а'.repeat(9)}…`)
    assert.equal(short('коротко'), 'коротко')
  })
})
