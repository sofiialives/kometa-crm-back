import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { breakItem, forceMajeureItem, groupByDay, redact, summarize } from '../botJournalRules.js'

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

  test('первые 15 минут после срока — ещё не «не отметился», как и у бота', () => {
    assert.ok(!breakItem(away(), T('12:40')).unmarked)
    assert.ok(breakItem(away(), T('12:45')).unmarked)
  })

  test('не отметился, а вечером «ухожу домой» — не 6 часов и не опоздание', () => {
    const b = breakItem(away({ from: T('14:00'), until: T('15:00'), returnedAt: T('18:30') }), T('19:00'))
    assert.equal(b.minutes, 60)
    assert.equal(b.lateMinutes, 0)
    assert.ok(b.unmarked)
    assert.equal(b.returnedAt, null)
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

describe('граница месяца', () => {
  const nov = { start: new Date('2026-11-01T00:00:00+03:00'), end: new Date('2026-12-01T00:00:00+03:00') }

  test('отлучка через полночь 31-го — в ноябре только ноябрьская часть, день — 1 ноября', () => {
    const b = breakItem(away({ from: T('23:50', '2026-10-31'), until: T('00:20', '2026-11-01'), returnedAt: T('00:18', '2026-11-01') }), T('12:00', '2026-11-01'), nov)
    assert.equal(b.minutes, 18)
    assert.ok(b.startedBefore)
    assert.deepEqual(groupByDay([b]).map((d) => d.day), ['2026-11-01'])
  })

  test('форс-мажор с 28 октября — в ноябре с 1 ноября и с пометкой', () => {
    const f = forceMajeureItem({ id: 'f', from: T('09:00', '2026-10-28'), until: T('18:00', '2026-11-03'), source: 'owner' }, nov)
    assert.equal(groupByDay([f])[0].day, '2026-11-01')
    assert.ok(f.startedBefore)
  })
})

describe('что видит руководитель', () => {
  test('без причин, ответов, слов и того, кто решал', () => {
    const items = [
      { kind: 'break', reason: 'к врачу' },
      { kind: 'force_majeure', reason: 'заболел', by: 'Ян' },
      { kind: 'checkin', answer: 'делаю отчёт' },
      { kind: 'late', text: 'пробки', data: { until: 'x' } },
      { kind: 'fm_decision', data: { approved: false, by: 'Ян' } },
    ].map((i) => redact(i, false))
    for (const i of items) {
      assert.equal(i.reason, null)
      assert.equal(i.answer, null)
      assert.equal(i.text, null)
    }
    assert.equal(items[1].by, null)
    assert.equal(items[4].data.by, undefined)
    assert.equal(items[4].data.approved, false)
  })

  test('владелец видит всё', () => {
    assert.equal(redact({ kind: 'break', reason: 'к врачу' }, true).reason, 'к врачу')
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
    { kind: 'task_done', at: T('16:00'), data: { onTime: true } },
    { kind: 'task_done', at: T('19:00'), data: { onTime: false } },
    { kind: 'task_overdue', at: T('23:59'), data: { nights: 1 } },
    { kind: 'task_extended', at: T('17:00'), data: {} },
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
    assert.equal(s.tasksDone, 2)
    assert.equal(s.tasksDoneLate, 1)
    assert.equal(s.tasksOverdue, 1)
    assert.equal(s.tasksExtended, 1)
  })

  test('дни по Москве, свежие сверху, внутри — по времени', () => {
    const days = groupByDay(items, [{ at: T('12:00'), direction: 'in', text: 'отхожу' }])
    assert.deepEqual(days.map((d) => d.day), ['2026-11-05', '2026-11-04', '2026-11-03'])
    assert.deepEqual(days[2].items.map((i) => i.kind), ['late', 'break', 'checkin', 'task_done', 'task_extended', 'task_late', 'task_done', 'task_overdue'])
    assert.equal(days[2].messages.length, 1)
  })

  test('23:30 по Москве — тот же день, а не следующий по UTC', () => {
    const days = groupByDay([{ kind: 'late', at: new Date('2026-11-03T20:30:00Z') }])
    assert.equal(days[0].day, '2026-11-03')
  })
})
