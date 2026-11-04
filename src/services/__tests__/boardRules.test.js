import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { resolveRange } from '../boardRules.js'

const iso = (d) => d.toISOString()

describe('периоды доски', () => {
  test('месяц — от первого числа до первого числа следующего', () => {
    const r = resolveRange({ mode: 'month', month: new Date('2026-11-17T10:00:00.000Z') })
    assert.equal(iso(r.gte), '2026-11-01T00:00:00.000Z')
    assert.equal(iso(r.lt), '2026-12-01T00:00:00.000Z')
  })

  test('за всё время — без границ', () => {
    assert.equal(resolveRange({ mode: 'all' }), null)
  })

  test('произвольный период без дат — без границ, с одной датой — с одной', () => {
    assert.equal(resolveRange({ mode: 'period' }), null)
    const r = resolveRange({ mode: 'period', from: new Date('2026-09-15T00:00:00.000Z') })
    assert.equal(iso(r.gte), '2026-09-15T00:00:00.000Z')
    assert.equal(r.lte, undefined)
  })
})

describe('последние месяцы считаются по Москве', () => {
  test('середина месяца — окно начинается с первого числа нужного месяца', () => {
    const now = new Date('2026-11-15T10:00:00.000Z')
    assert.equal(iso(resolveRange({ mode: 'last', months: 1 }, now).gte), '2026-11-01T00:00:00.000Z')
    assert.equal(iso(resolveRange({ mode: 'last', months: 3 }, now).gte), '2026-09-01T00:00:00.000Z')
  })

  test('в час ночи первого числа по Москве уже новый месяц, хотя по UTC ещё прошлый', () => {
    // 31 октября 22:00 UTC — это 1 ноября 01:00 по Москве.
    const now = new Date('2026-10-31T22:00:00.000Z')
    const r = resolveRange({ mode: 'last', months: 1 }, now)
    assert.equal(iso(r.gte), '2026-11-01T00:00:00.000Z')
  })

  test('ноябрьская услуга в этот момент не «из будущего»', () => {
    const now = new Date('2026-10-31T22:00:00.000Z')
    const r = resolveRange({ mode: 'last', months: 1 }, now)
    const novemberService = new Date('2026-11-01T00:00:00.000Z')
    assert.ok(novemberService >= r.gte && novemberService <= r.lte)
  })

  test('без пяти минут полночь по Москве ещё прежний месяц', () => {
    // 31 октября 20:55 UTC — это 31 октября 23:55 по Москве.
    const now = new Date('2026-10-31T20:55:00.000Z')
    assert.equal(iso(resolveRange({ mode: 'last', months: 1 }, now).gte), '2026-10-01T00:00:00.000Z')
  })

  test('окно переходит через новый год', () => {
    const now = new Date('2027-01-10T12:00:00.000Z')
    assert.equal(iso(resolveRange({ mode: 'last', months: 3 }, now).gte), '2026-11-01T00:00:00.000Z')
  })
})
