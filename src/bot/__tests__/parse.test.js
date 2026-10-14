import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { isBareTime, parseIntent, parseUntil } from '../parse.js'

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

describe('что не отлучка и не форс-мажор', () => {
  const now = new Date('2026-11-03T12:00:00+03:00')
  test('«не будет» о сайте или времени — не отлучка', () => {
    assert.equal(parseIntent('Сайт не будет работать до 17', now), null)
    assert.equal(parseIntent('не будет времени созвониться', now), null)
  })

  test('«ухожу домой», «на сегодня всё» — конец дня', () => {
    assert.equal(parseIntent('всем пока, ухожу домой', now).type, 'day_end')
    assert.equal(parseIntent('ушёл на сегодня', now).type, 'day_end')
    assert.equal(parseIntent('на сегодня всё, до завтра', now).type, 'day_end')
    assert.equal(parseIntent('еду домой на обед, вернусь в 14', now).type, 'away')
  })

  test('«сделаю до завтра», «заеду домой, потом созвон» — не конец дня; задержка важнее', () => {
    assert.notEqual(parseIntent('до завтра закончу отчёт', now)?.type, 'day_end')
    assert.notEqual(parseIntent('домой заеду, потом на созвон', now)?.type, 'day_end')
    assert.equal(parseIntent('Задерживаюсь, еду домой из-за пробок', now).type, 'late')
  })

  test('«на сегодня все задачи закрыл» — не конец дня, «на сегодня всё!» — конец', () => {
    for (const t of ['на сегодня все задачи закрыл', 'на сегодня вся работа сделана', 'на сегодня всем спасибо', 'на сегодня закончил задачу']) {
      assert.notEqual(parseIntent(t, now)?.type, 'day_end', t)
    }
    assert.equal(parseIntent('на сегодня всё!', now).type, 'day_end')
    assert.equal(parseIntent('на сегодня закончила', now).type, 'day_end')
  })

  test('вернулся с обеда или перерыва — это возвращение', () => {
    assert.equal(parseIntent('вернулся с перерыва', now).type, 'back')
    assert.equal(parseIntent('я на месте, был на обеде', now).type, 'back')
    assert.equal(parseIntent('вернулась, ходила на обед', now).type, 'back')
    assert.equal(parseIntent('я тут, перерыв закончился', now).type, 'back')
    assert.equal(parseIntent('ушла на обед', now).type, 'away')
  })

  test('заболела голова, но работаю — не форс-мажор; температура спала — вернулся', () => {
    assert.notEqual(parseIntent('Заболела голова, но работаю', now)?.type, 'force_majeure')
    assert.equal(parseIntent('вернулся, температура спала', now).type, 'back')
    assert.equal(parseIntent('заболел, на больничном', now).type, 'force_majeure')
  })

  test('«не успеваю закончить, отхожу на час» — отлучка на час', () => {
    const r = parseIntent('Не успеваю закончить, отхожу на час', now)
    assert.equal(r.type, 'away')
    assert.equal(r.until.toISOString(), new Date('2026-11-03T13:00:00+03:00').toISOString())
  })
})

describe('напоминания', () => {
  const now = new Date('2026-11-03T12:00:00+03:00')
  test('«напомни в 15:00 позвонить клиенту» — напоминание на 15:00', () => {
    const r = parseIntent('напомни мне в 15:00 позвонить клиенту', now)
    assert.equal(r.type, 'remind')
    assert.equal(r.until.toISOString(), new Date('2026-11-03T15:00:00+03:00').toISOString())
  })
  test('«через 20 минут напомни про отчёт» — через 20 минут', () => {
    const r = parseIntent('через 20 минут напомни про отчёт', now)
    assert.equal(r.type, 'remind')
    assert.equal(r.until.toISOString(), new Date('2026-11-03T12:20:00+03:00').toISOString())
  })
  test('без времени — напоминание без срока, «напоминание» — не просьба', () => {
    assert.equal(parseIntent('напомни позвонить клиенту', now).until, null)
    assert.equal(parseIntent('спасибо за напоминание', now), null)
  })
})

describe('только время', () => {
  test('«до 16:30», «к 17», «16:30» — да; фраза со временем — нет', () => {
    assert.ok(isBareTime('до 16:30'))
    assert.ok(isBareTime('к 17'))
    assert.ok(isBareTime('16:30'))
    assert.ok(!isBareTime('встреча в 15:00, не беспокоить'))
    assert.ok(!isBareTime('сдам отчёт до 17'))
  })
})
