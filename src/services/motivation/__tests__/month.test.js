import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  currentMonthKey, dayKeyOf, isMonthKey, monthKeyOf, monthRange, monthsBetween, referenceMoment, shiftMonth,
} from '../month.js'

describe('московские месяцы', () => {
  test('полночь первого числа по Москве — это уже новый месяц', () => {
    // 31 октября 21:00 UTC — это 1 ноября 00:00 по Москве.
    assert.equal(monthKeyOf('2026-10-31T21:00:00.000Z'), '2026-11')
    assert.equal(monthKeyOf('2026-10-31T20:59:59.999Z'), '2026-10')
  })

  test('границы месяца в UTC сдвинуты на три часа назад', () => {
    const { start, end } = monthRange('2026-11')
    assert.equal(start.toISOString(), '2026-10-31T21:00:00.000Z')
    assert.equal(end.toISOString(), '2026-11-30T21:00:00.000Z')
  })

  test('переход через год', () => {
    assert.equal(shiftMonth('2026-01', -1), '2025-12')
    assert.equal(shiftMonth('2026-12', 1), '2027-01')
    const { end } = monthRange('2026-12')
    assert.equal(end.toISOString(), '2026-12-31T21:00:00.000Z')
  })

  test('список месяцев между двумя', () => {
    assert.deepEqual(monthsBetween('2026-11', '2027-02'), ['2026-11', '2026-12', '2027-01', '2027-02'])
    assert.deepEqual(monthsBetween('2026-11', '2026-11'), ['2026-11'])
    assert.deepEqual(monthsBetween('2027-01', '2026-11'), [])
  })

  test('проверка формата', () => {
    assert.equal(isMonthKey('2026-11'), true)
    assert.equal(isMonthKey('2026-13'), false)
    assert.equal(isMonthKey('2026-1'), false)
    assert.equal(isMonthKey(undefined), false)
  })

  test('московская дата', () => {
    assert.equal(dayKeyOf('2026-11-14T22:30:00.000Z'), '2026-11-15')
    assert.equal(dayKeyOf('2026-11-14T20:30:00.000Z'), '2026-11-14')
  })

  test('текущий месяц считается по Москве', () => {
    assert.equal(currentMonthKey(new Date('2026-10-31T22:00:00.000Z')), '2026-11')
  })

  test('опорный момент: для прошлого месяца — его конец, для текущего — сейчас', () => {
    const now = new Date('2026-11-15T10:00:00.000Z')
    assert.equal(referenceMoment('2026-10', now).toISOString(), '2026-10-31T20:59:59.999Z')
    assert.equal(referenceMoment('2026-11', now).toISOString(), now.toISOString())
  })
})
