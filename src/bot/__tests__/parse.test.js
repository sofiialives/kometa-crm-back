import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseIntent, parseUntil } from '../parse.js'

// Сейчас — 14:00 по Москве.
const now = new Date('2026-11-03T14:00:00+03:00')
const msk = (time) => new Date(`2026-11-03T${time}:00+03:00`).toISOString()
const minutesFromNow = (d) => Math.round((d.getTime() - now.getTime()) / 60000)

describe('до какого времени', () => {
  test('минуты и часы', () => {
    assert.equal(minutesFromNow(parseUntil('отхожу на 30 минут', now)), 30)
    assert.equal(minutesFromNow(parseUntil('буду через 20 мин', now)), 20)
    assert.equal(minutesFromNow(parseUntil('на 15м', now)), 15)
    assert.equal(minutesFromNow(parseUntil('отойду на час', now)), 60)
    assert.equal(minutesFromNow(parseUntil('на два часа', now)), 120)
    assert.equal(minutesFromNow(parseUntil('на 1.5 часа', now)), 90)
    assert.equal(minutesFromNow(parseUntil('на полчаса', now)), 30)
    assert.equal(minutesFromNow(parseUntil('на полтора часа', now)), 90)
  })

  test('к часу дня по Москве', () => {
    assert.equal(parseUntil('вернусь в 16:30', now).toISOString(), msk('16:30'))
    assert.equal(parseUntil('буду до 17', now).toISOString(), msk('17:00'))
    assert.equal(parseUntil('к 17.15', now).toISOString(), msk('17:15'))
  })

  test('прошедшее время и слишком долгая отлучка — не время', () => {
    assert.equal(parseUntil('вернусь в 9:00', now), null)
    assert.equal(parseUntil('отойду на 12 часов', now), null)
    assert.equal(parseUntil('отхожу', now), null)
  })
})

describe('что человек хочет сказать', () => {
  test('отходит — со временем и без', () => {
    assert.deepEqual(parseIntent('Отхожу на обед', now), { type: 'away', until: null })
    const away = parseIntent('Отойду на 40 минут, к врачу', now)
    assert.equal(away.type, 'away')
    assert.equal(minutesFromNow(away.until), 40)
  })

  test('вернулся', () => {
    assert.deepEqual(parseIntent('Вернулся!', now), { type: 'back' })
    assert.deepEqual(parseIntent('я на месте', now), { type: 'back' })
    assert.deepEqual(parseIntent('Всё, я тут', now), { type: 'back' })
  })

  test('«буду на месте в 16:30» — это отлучка до 16:30', () => {
    const r = parseIntent('буду на месте в 16:30', now)
    assert.equal(r.type, 'away')
    assert.equal(r.until.toISOString(), msk('16:30'))
  })

  test('задерживается', () => {
    const r = parseIntent('Задерживаюсь, буду в 15:20', now)
    assert.equal(r.type, 'late')
    assert.equal(r.until.toISOString(), msk('15:20'))
    assert.equal(parseIntent('опаздываю', now).type, 'late')
  })

  test('форс-мажор и болезнь', () => {
    assert.equal(parseIntent('У меня форс-мажор, до 18', now).type, 'force_majeure')
    assert.equal(parseIntent('заболел', now).type, 'force_majeure')
  })

  test('буква ё и регистр не мешают', () => {
    assert.equal(parseIntent('УШЁЛ на 10 минут', now).type, 'away')
  })

  test('обычный вопрос — не понято, бот предложит кнопки', () => {
    assert.equal(parseIntent('Сколько у меня баллов?', now), null)
    assert.equal(parseIntent('', now), null)
  })
})
