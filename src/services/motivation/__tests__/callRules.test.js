import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { CALL_EVENT_KEYS, callMoment, isAwayAt, journalDayError } from '../callRules.js'

// Время по Москве: msk('2026-11-03 18:00').
const msk = (text) => {
  const [day, time = '00:00'] = text.split(' ')
  return new Date(`${day}T${time}:00+03:00`)
}

describe('какой день можно отметить в журнале', () => {
  const now = msk('2026-11-12 20:30')

  test('сегодня и прошлые дни текущего месяца — можно', () => {
    assert.equal(journalDayError('2026-11-12', now), null)
    assert.equal(journalDayError('2026-11-01', now), null)
  })

  test('будущий день и прошлый месяц — нельзя', () => {
    assert.match(journalDayError('2026-11-13', now), /Будущий/)
    assert.match(journalDayError('2026-10-31', now), /текущего месяца/)
  })

  test('кривые даты отклоняются', () => {
    assert.ok(journalDayError('2026-11-31', now))
    assert.ok(journalDayError('12.11.2026', now))
  })
})

describe('момент баллов за звонок', () => {
  test('прошлый день — 19:00 по Москве', () => {
    assert.equal(callMoment('2026-11-10', msk('2026-11-12 10:00')).toISOString(), msk('2026-11-10 19:00').toISOString())
  })

  test('отметили во время сегодняшнего звонка, до 19:00 — сейчас', () => {
    const now = msk('2026-11-12 18:55')
    assert.equal(callMoment('2026-11-12', now).toISOString(), now.toISOString())
  })

  test('отметили после звонка — 19:00', () => {
    assert.equal(callMoment('2026-11-12', msk('2026-11-12 21:00')).toISOString(), msk('2026-11-12 19:00').toISOString())
  })
})

describe('метка «форс-мажор»', () => {
  const away = { from: msk('2026-11-12 15:00'), until: msk('2026-11-12 20:00'), endedAt: null }

  test('действует внутри интервала, конец не включён', () => {
    assert.ok(isAwayAt(away, msk('2026-11-12 19:00')))
    assert.ok(!isAwayAt(away, msk('2026-11-12 20:00')))
    assert.ok(!isAwayAt(away, msk('2026-11-12 14:59')))
  })

  test('снятая раньше срока метка не действует', () => {
    assert.ok(!isAwayAt({ ...away, endedAt: msk('2026-11-12 16:00') }, msk('2026-11-12 19:00')))
  })

  test('события журнала — «был» и «не был», у форс-мажора события нет', () => {
    assert.deepEqual(CALL_EVENT_KEYS, { present: 'call_attended', absent: 'call_missed' })
  })
})
