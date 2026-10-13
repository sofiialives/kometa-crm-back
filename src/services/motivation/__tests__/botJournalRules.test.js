import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { breakItem, groupByDay, summarize } from '../botJournalRules.js'

const T = (hm, day = '2026-11-03') => new Date(`${day}T${hm}:00+03:00`)
const away = (extra) => ({ id: 'a', from: T('12:00'), until: T('12:30'), returnedAt: null, endedAt: null, extensions: 0, source: 'bot', ...extra })

describe('отлучка в журнале', () => {
  test('вернулся с опозданием — время до возвращения и опоздание', () => {
    const b = breakItem(away({ until: T('12:38'), returnedAt: T('12:40'), extensions: 1 }), T('15:00'))
    assert.equal(b.minutes, 40)
    assert.equal(b.lateMinutes, 2)
    assert.equal(b.extensions, 1)
    assert.ok(!b.unmarked && !b.ongoing)
  })

  test('вернулся раньше — без опоздания', () => {
    const b = breakItem(away({ returnedAt: T('12:20') }), T('15:00'))
    assert.equal(b.minutes, 20)
    assert.equal(b.lateMinutes, 0)
  })

  test('не отметился — до срока и помечено', () => {
    const b = breakItem(away(), T('15:00'))
    assert.equal(b.minutes, 30)
    assert.ok(b.unmarked)
  })

  test('ещё идёт — до сейчас', () => {
    const b = breakItem(away(), T('12:10'))
    assert.equal(b.minutes, 10)
    assert.ok(b.ongoing && !b.unmarked)
  })

  test('сняли раньше срока в CRM — до снятия, не «не отметился»', () => {
    const b = breakItem(away({ endedAt: T('12:15') }), T('15:00'))
    assert.equal(b.minutes, 15)
    assert.ok(!b.unmarked)
  })
})

describe('сводка и дни', () => {
  const items = [
    breakItem(away({ until: T('12:38'), returnedAt: T('12:40'), extensions: 1 }), T('20:00')),
    breakItem(away({ id: 'b', from: T('10:00', '2026-11-04'), until: T('11:00', '2026-11-04') }), T('20:00', '2026-11-04')),
    { kind: 'checkin', at: T('15:21'), status: 'answered' },
    { kind: 'checkin', at: T('14:02', '2026-11-04'), status: 'penalized' },
    { kind: 'late', at: T('09:50') },
    { kind: 'task_late', at: T('17:26') },
    { kind: 'force_majeure', at: T('09:00', '2026-11-05') },
  ]

  test('сводка за месяц', () => {
    const s = summarize(items)
    assert.equal(s.breaks, 2)
    assert.equal(s.awayMinutes, 100)
    assert.equal(s.lateBreaks, 1)
    assert.equal(s.unmarked, 1)
    assert.deepEqual(s.checkins, { asked: 2, answered: 1, penalized: 1, skipped: 0 })
    assert.equal(s.lateReports, 2)
    assert.equal(s.forceMajeure, 1)
  })

  test('дни по Москве, свежие сверху, внутри — по времени', () => {
    const days = groupByDay(items, [{ at: T('12:00'), direction: 'in', text: 'отхожу' }])
    assert.deepEqual(days.map((d) => d.day), ['2026-11-05', '2026-11-04', '2026-11-03'])
    assert.deepEqual(days[2].items.map((i) => i.kind), ['late', 'break', 'checkin', 'task_late'])
    assert.equal(days[2].messages.length, 1)
  })

  test('23:30 по Москве — тот же день, а не следующий по UTC', () => {
    const days = groupByDay([{ kind: 'late', at: new Date('2026-11-03T20:30:00Z') }])
    assert.equal(days[0].day, '2026-11-03')
  })
})
