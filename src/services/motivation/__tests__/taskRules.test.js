import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  autoActiveAt, autoKey, autoKeyPrefix, capGain, capPenalty, isOnTime,
  mskDateStart, mskDayStart, overdueNights, ruleFor,
} from '../taskRules.js'

// Время по Москве: msk('2026-11-03 18:00') — 18:00 по Москве, это 15:00 UTC.
const msk = (text) => {
  const [day, time = '00:00:00'] = text.split(' ')
  return new Date(`${day}T${time.length === 5 ? `${time}:00` : time}+03:00`)
}

describe('правило по задаче', () => {
  test('задачи из Иерархии и личные идут разными событиями', () => {
    assert.equal(ruleFor({ origin: 'hierarchy' }, 'on_time'), 'task_on_time')
    assert.equal(ruleFor({ origin: 'personal' }, 'on_time'), 'personal_task_on_time')
    assert.equal(ruleFor({ origin: 'hierarchy' }, 'overdue'), 'task_overdue')
    assert.equal(ruleFor({ origin: 'personal' }, 'overdue'), 'personal_task_overdue')
  })

  test('в срок — закрыта не позже срока, минута в минуту тоже в срок', () => {
    const deadline = msk('2026-11-03 18:00')
    assert.ok(isOnTime({ status: 'done', doneAt: msk('2026-11-03 17:59'), deadline }))
    assert.ok(isOnTime({ status: 'done', doneAt: deadline, deadline }))
    assert.ok(!isOnTime({ status: 'done', doneAt: msk('2026-11-03 18:01'), deadline }))
  })

  test('не закрытая задача — не в срок', () => {
    const deadline = msk('2026-11-03 18:00')
    assert.ok(!isOnTime({ status: 'progress', doneAt: null, deadline }))
    assert.ok(!isOnTime({ status: 'done', doneAt: null, deadline }))
  })
})

describe('включение автобаллов', () => {
  test('выключены, пока дата не задана, и не действуют до неё', () => {
    assert.ok(!autoActiveAt(null, msk('2026-11-05 10:00')))
    assert.ok(!autoActiveAt(msk('2026-11-01'), msk('2026-10-31 23:59')))
    assert.ok(autoActiveAt(msk('2026-11-01'), msk('2026-11-01 00:00')))
  })
})

describe('московские сутки', () => {
  test('начало суток считается по Москве, а не по UTC', () => {
    // 01:30 по Москве — это ещё 22:30 предыдущего дня по UTC.
    assert.equal(mskDayStart(msk('2026-11-03 01:30')).toISOString(), msk('2026-11-03 00:00').toISOString())
    assert.equal(mskDayStart(msk('2026-11-03 23:59')).toISOString(), msk('2026-11-03 00:00').toISOString())
  })

  test('дата из настроек — московская полночь', () => {
    assert.equal(mskDateStart('2026-11-01').toISOString(), msk('2026-11-01 00:00').toISOString())
  })
})

describe('ночи просрочки', () => {
  const autoFrom = msk('2026-11-01 00:00')

  test('первый штраф — в первую полночь после срока, датирован ушедшими сутками', () => {
    const nights = overdueNights({ deadline: msk('2026-11-03 18:00'), autoFrom, now: msk('2026-11-04 00:00:05') })
    assert.deepEqual(nights.map((n) => n.dayKey), ['2026-11-03'])
    assert.equal(nights[0].at.toISOString(), msk('2026-11-03 23:59:59').toISOString())
  })

  test('до полуночи штрафа нет, даже если срок прошёл', () => {
    assert.deepEqual(overdueNights({ deadline: msk('2026-11-03 18:00'), autoFrom, now: msk('2026-11-03 23:00') }), [])
  })

  test('каждая следующая ночь — ещё штраф, пропущенные ночи тоже видны', () => {
    const nights = overdueNights({ deadline: msk('2026-11-03 18:00'), autoFrom, now: msk('2026-11-06 12:00') })
    assert.deepEqual(nights.map((n) => n.dayKey), ['2026-11-03', '2026-11-04', '2026-11-05'])
  })

  test('просрочка 31-го остаётся в своём месяце', () => {
    const nights = overdueNights({ deadline: msk('2026-11-30 18:00'), autoFrom, now: msk('2026-12-01 00:00:05') })
    assert.equal(nights[0].dayKey, '2026-11-30')
    assert.ok(nights[0].at < msk('2026-12-01 00:00'))
  })

  test('задачи, просроченные до включения автобаллов, не штрафуются', () => {
    assert.deepEqual(overdueNights({ deadline: msk('2026-10-20 18:00'), autoFrom, now: msk('2026-11-10 00:00:05') }), [])
  })

  test('автобаллы выключены — штрафов нет', () => {
    assert.deepEqual(overdueNights({ deadline: msk('2026-11-03 18:00'), autoFrom: null, now: msk('2026-11-10 00:00:05') }), [])
  })

  test('срок в последнюю секунду суток — штраф в эту же полночь', () => {
    const nights = overdueNights({ deadline: msk('2026-11-03 23:59:59'), autoFrom, now: msk('2026-11-04 00:00:05') })
    assert.deepEqual(nights.map((n) => n.dayKey), ['2026-11-03'])
  })

  test('срок ровно в полночь — первый штраф следующей ночью', () => {
    const nights = overdueNights({ deadline: msk('2026-11-04 00:00'), autoFrom, now: msk('2026-11-04 00:00:05') })
    assert.deepEqual(nights, [])
  })
})

describe('лимиты', () => {
  test('личные задачи: не больше дневного потолка', () => {
    assert.equal(capGain(1, 0, 2), 1)
    assert.equal(capGain(1, 1, 2), 1)
    assert.equal(capGain(1, 2, 2), 0)
    assert.equal(capGain(3, 1, 2), 1)
  })

  test('потолок 0 — личные задачи баллов не дают', () => {
    assert.equal(capGain(1, 0, 0), 0)
  })

  test('штраф за просрочку не больше лимита на задачу', () => {
    assert.equal(capPenalty(-2, 0, 10), -2)
    assert.equal(capPenalty(-2, 8, 10), -2)
    assert.equal(capPenalty(-2, 9, 10), -1)
    assert.equal(capPenalty(-2, 10, 10), 0)
    assert.equal(capPenalty(-2, 12, 10), 0)
  })

  test('событие с плюсом лимит не режет: это решение владельца', () => {
    assert.equal(capPenalty(2, 10, 10), 2)
    assert.equal(capGain(-1, 5, 2), -1)
  })
})

describe('ключи записей', () => {
  test('ключ начинается с правила и задачи, у разных задач начала не пересекаются', () => {
    const key = autoKey('task_overdue', 'task1', '2026-11-03')
    assert.equal(key, 'auto:task_overdue:task1:2026-11-03')
    assert.ok(key.startsWith(autoKeyPrefix('task_overdue', 'task1')))
    assert.ok(!autoKey('task_overdue', 'task10', 'x').startsWith(autoKeyPrefix('task_overdue', 'task1')))
  })
})
