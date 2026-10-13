import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { dueInMinutes, isCheckinDay, isQuietHour, isWorkday, mskDayKey, randomCheckinTime, workdaysAfter } from '../plan.js'

describe('рабочие дни', () => {
  test('понедельник–пятница — будни, суббота и воскресенье — нет', () => {
    assert.ok(isWorkday('2026-11-02'))
    assert.ok(isWorkday('2026-11-06'))
    assert.ok(!isWorkday('2026-11-07'))
    assert.ok(!isWorkday('2026-11-08'))
  })

  test('московская дата: 23:30 по UTC — это уже завтра', () => {
    assert.equal(mskDayKey(new Date('2026-11-02T23:30:00Z')), '2026-11-03')
  })

  test('рабочие дни после даты не считают выходные', () => {
    assert.equal(workdaysAfter('2026-11-05', '2026-11-10'), 3) // пт, пн, вт
  })
})

describe('внезапный чек-ин', () => {
  test('раз в три рабочих дня', () => {
    assert.ok(!isCheckinDay('2026-11-02', '2026-11-04'))
    assert.ok(isCheckinDay('2026-11-02', '2026-11-05'))
  })

  test('через выходные считаются только будни', () => {
    assert.ok(!isCheckinDay('2026-11-05', '2026-11-09')) // пт, пн — два
    assert.ok(isCheckinDay('2026-11-05', '2026-11-10'))
  })

  test('в выходные не бывает, первый — сразу', () => {
    assert.ok(!isCheckinDay(null, '2026-11-07'))
    assert.ok(isCheckinDay(null, '2026-11-09'))
  })

  test('время — с 11:00 до 18:15 по Москве', () => {
    assert.equal(randomCheckinTime('2026-11-03', () => 0).toISOString(), new Date('2026-11-03T11:00:00+03:00').toISOString())
    assert.equal(randomCheckinTime('2026-11-03', () => 0.9999).toISOString(), new Date('2026-11-03T18:15:00+03:00').toISOString())
  })
})

describe('окно напоминаний', () => {
  const now = new Date('2026-11-03T15:55:00+03:00')
  test('задача в 16:00 — напоминание «за 5 минут» срабатывает в 15:55', () => {
    assert.ok(dueInMinutes(new Date('2026-11-03T16:00:00+03:00'), now, 5))
    assert.ok(!dueInMinutes(new Date('2026-11-03T16:01:00+03:00'), now, 5))
    assert.ok(!dueInMinutes(new Date('2026-11-03T15:59:00+03:00'), now, 5))
  })
})

describe('тихие часы', () => {
  test('с 21:00 до 9:00 по Москве бот молчит', () => {
    assert.ok(isQuietHour(new Date('2026-11-03T21:00:00+03:00')))
    assert.ok(isQuietHour(new Date('2026-11-03T08:59:00+03:00')))
    assert.ok(!isQuietHour(new Date('2026-11-03T09:00:00+03:00')))
    assert.ok(!isQuietHour(new Date('2026-11-03T20:59:00+03:00')))
  })
})
