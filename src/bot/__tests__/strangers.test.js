import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { shouldAnswerStranger } from '../updates.js'

describe('чужие чаты, которых нет в CRM', () => {
  test('подсказка не чаще раза в сутки', () => {
    const t0 = Date.parse('2026-10-15T10:00:00Z')
    assert.equal(shouldAnswerStranger(777001, t0), true)
    assert.equal(shouldAnswerStranger(777001, t0 + 60_000), false)
    assert.equal(shouldAnswerStranger(777001, t0 + 23 * 3600e3), false)
    assert.equal(shouldAnswerStranger(777001, t0 + 24 * 3600e3 + 1), true)
    assert.equal(shouldAnswerStranger(777002, t0 + 60_000), true)
  })

  test('на голый /start подсказка каждый раз, сутки после него считаются заново', () => {
    const t0 = Date.parse('2026-11-04T10:00:00Z')
    assert.equal(shouldAnswerStranger(777003, t0), true)
    assert.equal(shouldAnswerStranger(777003, t0 + 60_000, { start: true }), true)
    assert.equal(shouldAnswerStranger(777003, t0 + 120_000), false)
  })
})
