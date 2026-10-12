import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildTimeline, clampPoints, computeMonth, levelAmount, reachedCount,
  replayPrize, roundToDollar, validateScale, validateWorkLevels, workLevelFor,
} from '../engine.js'

// Шкала из задания: пять уровней по 20 баллов, доли 15/30/50/75/100.
const SCALE = [
  { position: 1, threshold: 20, percent: 15 },
  { position: 2, threshold: 40, percent: 30 },
  { position: 3, threshold: 60, percent: 50 },
  { position: 4, threshold: 80, percent: 75 },
  { position: 5, threshold: 100, percent: 100 },
]

const WORK = [
  { title: 'Разгоняемся', minPoints: 0, hint: 'a' },
  { title: 'Хороший темп', minPoints: 30, hint: 'b' },
  { title: 'Сильный результат', minPoints: 60, hint: 'c' },
  { title: 'Отлично', minPoints: 80, hint: 'd' },
]

// Записи журналов собираются по минутам от начала месяца: так порядок
// виден прямо в тесте, и не нужно держать в голове даты.
const at = (minute) => new Date(Date.UTC(2026, 10, 1, 0, minute)).toISOString()
const bank = (minute, dollars) => ({ id: `b${minute}`, occurredAt: at(minute), amountCents: dollars * 100 })
const ev = (minute, prize, level = prize, extra = {}) => ({ id: `e${minute}`, occurredAt: at(minute), prizePoints: prize, levelPoints: level, ...extra })

const dollars = (cents) => cents / 100
const amounts = (result) => result.levels.map((l) => dollars(l.amountCents))

describe('округление и доли', () => {
  test('сумма уровня округляется до целого доллара', () => {
    assert.equal(roundToDollar(3750), 3800)
    assert.equal(roundToDollar(3749), 3700)
    assert.equal(levelAmount(25000, 15), 3800)
    assert.equal(levelAmount(25000, 75), 18800)
  })

  test('таблица из задания: при банке 200 и 250 долларов', () => {
    const at200 = replayPrize({ levels: SCALE, bankEntries: [bank(0, 200)] })
    assert.deepEqual(amounts(at200), [30, 60, 100, 150, 200])

    const at250 = replayPrize({ levels: SCALE, bankEntries: [bank(0, 250)] })
    assert.deepEqual(amounts(at250), [38, 75, 125, 188, 250])
  })

  test('баллы не выходят за 0 и 100', () => {
    assert.equal(clampPoints(-5), 0)
    assert.equal(clampPoints(130), 100)
    assert.equal(clampPoints(42), 42)
  })

  test('сколько уровней пройдено', () => {
    assert.equal(reachedCount(SCALE, 0), 0)
    assert.equal(reachedCount(SCALE, 19), 0)
    assert.equal(reachedCount(SCALE, 20), 1)
    assert.equal(reachedCount(SCALE, 60), 3)
    assert.equal(reachedCount(SCALE, 100), 5)
  })
})

describe('пример из задания', () => {
  test('пополнили 50, потом до 200, набрал 60 баллов — забирает 100 из 200', () => {
    const r = replayPrize({
      levels: SCALE,
      bankEntries: [bank(1, 50), bank(2, 150)],
      events: [ev(10, 40), ev(11, 22), ev(12, -2)],
    })
    assert.equal(dollars(r.bankCents), 200)
    assert.equal(r.prizePoints, 60)
    assert.equal(r.currentLevel, 3)
    assert.equal(dollars(r.earnedCents), 100)
  })

  test('до следующего уровня 20 баллов, он даст 150', () => {
    const r = replayPrize({ levels: SCALE, bankEntries: [bank(0, 200)], events: [ev(5, 60)] })
    assert.deepEqual(r.next, { position: 4, threshold: 80, pointsLeft: 20, amountCents: 15000 })
  })

  test('премия ступенями и не суммируется: на третьем уровне 100, а не 30 + 60 + 100', () => {
    const r = replayPrize({ levels: SCALE, bankEntries: [bank(0, 200)], events: [ev(5, 65)] })
    assert.equal(dollars(r.earnedCents), 100)
  })

  test('пустой банк: все суммы ноль, баллы при этом копятся', () => {
    const r = replayPrize({ levels: SCALE, events: [ev(1, 30), ev(2, 15)] })
    assert.equal(r.bankCents, 0)
    assert.equal(r.prizePoints, 45)
    assert.equal(r.currentLevel, 2)
    assert.deepEqual(amounts(r), [0, 0, 0, 0, 0])
    assert.equal(r.earnedCents, 0)
  })
})

describe('правило с созвона: пополнение идёт только на непройденные уровни', () => {
  test('стоит на третьем уровне, банк вырос с 200 до 250: третий остаётся 100, растут четвёртый и пятый', () => {
    const r = replayPrize({
      levels: SCALE,
      bankEntries: [bank(0, 200), bank(30, 50)],
      events: [ev(10, 60)],
    })
    assert.deepEqual(amounts(r), [30, 60, 100, 188, 250])
    assert.equal(dollars(r.earnedCents), 100)
    assert.equal(r.levels[2].fixed, true)
    assert.equal(r.levels[3].fixed, false)
  })

  test('тот же банк, но третий уровень пройден уже после пополнения — он стоит 125', () => {
    const r = replayPrize({
      levels: SCALE,
      bankEntries: [bank(0, 200), bank(30, 50)],
      events: [ev(40, 60)],
    })
    assert.equal(dollars(r.earnedCents), 125)
  })

  test('нижние уровни тоже не растут, если уже пройдены', () => {
    const r = replayPrize({
      levels: SCALE,
      bankEntries: [bank(0, 100), bank(30, 100)],
      events: [ev(10, 45)],
    })
    // Первый и второй пройдены при банке 100: 15 и 30. Третий и выше — по 200.
    assert.deepEqual(amounts(r), [15, 30, 100, 150, 200])
    assert.equal(dollars(r.earnedCents), 30)
  })
})

describe('защита уровней, пройденных при пустом банке', () => {
  test('дошёл до третьего при пустом банке — первое пополнение фиксирует и пройденные', () => {
    const r = replayPrize({
      levels: SCALE,
      bankEntries: [bank(30, 200)],
      events: [ev(10, 60)],
    })
    assert.deepEqual(amounts(r), [30, 60, 100, 150, 200])
    assert.equal(dollars(r.earnedCents), 100)
    assert.equal(r.levels[2].fixed, true)
  })

  test('второе пополнение уже не трогает уровни, зафиксированные первым', () => {
    const r = replayPrize({
      levels: SCALE,
      bankEntries: [bank(30, 200), bank(40, 50)],
      events: [ev(10, 60)],
    })
    assert.deepEqual(amounts(r), [30, 60, 100, 188, 250])
    assert.equal(dollars(r.earnedCents), 100)
  })
})

describe('вершина шкалы', () => {
  test('дошёл до пятого при банке 200, банк вырос до 250 — получает весь банк, 250', () => {
    const r = replayPrize({
      levels: SCALE,
      bankEntries: [bank(0, 200), bank(30, 50)],
      events: [ev(10, 100)],
    })
    assert.equal(r.currentLevel, 5)
    assert.equal(dollars(r.earnedCents), 250)
    assert.equal(r.levels[4].fixed, false)
    assert.equal(r.next, null)
  })
})

describe('падение ниже уровня', () => {
  test('дошёл до третьего при 200, упал на второй, банк вырос до 250, вернулся — третий стоит 125', () => {
    const r = replayPrize({
      levels: SCALE,
      bankEntries: [bank(0, 200), bank(30, 50)],
      events: [ev(10, 60), ev(20, -5), ev(40, 5)],
    })
    assert.equal(r.currentLevel, 3)
    assert.equal(dollars(r.earnedCents), 125)
  })

  test('пока стоит ниже, упавший уровень показывается по текущему банку', () => {
    const r = replayPrize({
      levels: SCALE,
      bankEntries: [bank(0, 200), bank(30, 50)],
      events: [ev(10, 60), ev(20, -5)],
    })
    assert.equal(r.currentLevel, 2)
    assert.equal(dollars(r.levels[2].amountCents), 125)
    assert.equal(dollars(r.earnedCents), 60)
  })
})

describe('ноль баллов: штраф при нуле сгорает', () => {
  test('0, потом −10, потом +20 — это 20, а не 10', () => {
    const r = replayPrize({ levels: SCALE, events: [ev(1, -10), ev(2, 20)] })
    assert.equal(r.prizePoints, 20)
  })

  test('сверху то же самое: 95 + 10 даёт 100, потом −5 даёт 95', () => {
    const r = replayPrize({ levels: SCALE, events: [ev(1, 95), ev(2, 10), ev(3, -5)] })
    assert.equal(r.prizePoints, 95)
  })
})

describe('отмена и порядок записей', () => {
  test('отменённое событие не считается', () => {
    const r = replayPrize({
      levels: SCALE,
      bankEntries: [bank(0, 200)],
      events: [ev(1, 40), ev(2, 30, 30, { cancelledAt: at(3) })],
    })
    assert.equal(r.prizePoints, 40)
    assert.equal(r.currentLevel, 2)
  })

  test('при одинаковом времени деньги приходят раньше баллов', () => {
    const items = buildTimeline([bank(5, 100)], [ev(5, 20)])
    assert.deepEqual(items.map((i) => i.type), ['bank', 'event'])
  })

  test('порядок не зависит от порядка во входных массивах', () => {
    const a = replayPrize({ levels: SCALE, bankEntries: [bank(0, 200), bank(30, 50)], events: [ev(10, 60), ev(40, 20)] })
    const b = replayPrize({ levels: SCALE, bankEntries: [bank(30, 50), bank(0, 200)], events: [ev(40, 20), ev(10, 60)] })
    assert.deepEqual(a, b)
  })
})

describe('списание из банка', () => {
  test('зафиксированный уровень не может стоить больше, чем при новом банке', () => {
    const r = replayPrize({
      levels: SCALE,
      bankEntries: [bank(0, 200), bank(30, -80)],
      events: [ev(10, 60)],
    })
    assert.equal(dollars(r.bankCents), 120)
    // Третий был зафиксирован на 100, при банке 120 он стоит 60.
    assert.equal(dollars(r.earnedCents), 60)
    assert.deepEqual(amounts(r), [18, 36, 60, 90, 120])
  })

  test('банк не уходит в минус', () => {
    const r = replayPrize({ levels: SCALE, bankEntries: [bank(0, 50), bank(1, -80)] })
    assert.equal(r.bankCents, 0)
  })
})

describe('две шкалы', () => {
  test('баллы в премию и в уровень работы считаются раздельно', () => {
    const r = computeMonth({
      levels: SCALE,
      workLevels: WORK,
      bankEntries: [bank(0, 200)],
      events: [ev(1, 50, 20), ev(2, 10, 45)],
    })
    assert.equal(r.prizePoints, 60)
    assert.equal(r.levelPoints, 65)
    assert.equal(r.work.current.title, 'Сильный результат')
  })

  test('уровни работы: границы и сколько осталось до следующего', () => {
    assert.equal(workLevelFor(WORK, 0).current.title, 'Разгоняемся')
    assert.equal(workLevelFor(WORK, 29).current.title, 'Разгоняемся')
    assert.equal(workLevelFor(WORK, 30).current.title, 'Хороший темп')
    assert.equal(workLevelFor(WORK, 79).current.title, 'Сильный результат')
    assert.equal(workLevelFor(WORK, 80).current.title, 'Отлично')

    const mid = workLevelFor(WORK, 42)
    assert.equal(mid.next.title, 'Сильный результат')
    assert.equal(mid.pointsLeft, 18)
    assert.equal(workLevelFor(WORK, 95).next, null)
  })

  test('верхняя граница уровня — граница следующего минус один', () => {
    const { levels } = workLevelFor(WORK, 0)
    assert.deepEqual(levels.map((l) => [l.minPoints, l.maxPoints]), [[0, 29], [30, 59], [60, 79], [80, 100]])
  })
})

describe('своя шкала профиля', () => {
  test('три уровня вместо пяти считаются по тем же правилам', () => {
    const custom = [
      { threshold: 30, percent: 20 },
      { threshold: 70, percent: 60 },
      { threshold: 100, percent: 100 },
    ]
    const r = replayPrize({ levels: custom, bankEntries: [bank(0, 300), bank(20, 100)], events: [ev(10, 75)] })
    assert.equal(r.currentLevel, 2)
    // Второй зафиксирован при 300: 180. Последний — весь банк, 400.
    assert.deepEqual(amounts(r), [60, 180, 400])
    assert.equal(dollars(r.earnedCents), 180)
  })
})

describe('проверка шкалы', () => {
  test('шкала из задания проходит', () => {
    assert.deepEqual(validateScale(SCALE), [])
  })

  test('пороги и доли должны расти, последний уровень — 100%', () => {
    const errors = validateScale([
      { threshold: 40, percent: 30 },
      { threshold: 30, percent: 20 },
      { threshold: 90, percent: 80 },
    ])
    assert.ok(errors.some((e) => e.includes('порог должен быть больше')))
    assert.ok(errors.some((e) => e.includes('доля должна быть больше')))
    assert.ok(errors.some((e) => e.includes('100%')))
  })

  test('пустая шкала и выход за границы', () => {
    assert.equal(validateScale([]).length, 1)
    assert.ok(validateScale([{ threshold: 0, percent: 100 }]).some((e) => e.includes('порог')))
    assert.ok(validateScale([{ threshold: 101, percent: 100 }]).some((e) => e.includes('порог')))
  })

  test('уровни работы начинаются с нуля и растут', () => {
    assert.deepEqual(validateWorkLevels(WORK), [])
    assert.ok(validateWorkLevels([{ title: 'A', minPoints: 10 }]).some((e) => e.includes('с 0')))
    assert.ok(validateWorkLevels([{ title: 'A', minPoints: 0 }, { title: 'B', minPoints: 0 }]).some((e) => e.includes('больше')))
    assert.ok(validateWorkLevels([{ title: ' ', minPoints: 0 }]).some((e) => e.includes('название')))
  })
})

describe('ноль долларов — не фиксация', () => {
  test('ошибочное пополнение списали целиком — уровни ждут следующего пополнения', () => {
    // 45 баллов при пустом банке, ошибочные 100 $, их списание, потом 200 $.
    const r = replayPrize({
      levels: SCALE,
      bankEntries: [bank(10, 100), bank(20, -100), bank(30, 200)],
      events: [ev(5, 45)],
    })
    assert.deepEqual(amounts(r), [30, 60, 100, 150, 200])
    assert.equal(dollars(r.earnedCents), 60)
  })

  test('в банке пара долларов, доля округлилась до нуля — уровень не застывает на нуле', () => {
    const r = replayPrize({
      levels: SCALE,
      bankEntries: [bank(0, 2), bank(30, 198)],
      events: [ev(10, 25)],
    })
    // Первый уровень пройден при банке 2 $: 15% — это 0 $. Фиксируется он
    // пополнением до 200 $, то есть на 30 $.
    assert.equal(dollars(r.levels[0].amountCents), 30)
    assert.equal(dollars(r.earnedCents), 30)
  })

  test('нижний уровень, дождавшийся денег, не дороже уже зафиксированного верхнего', () => {
    const r = replayPrize({
      levels: SCALE,
      bankEntries: [bank(0, 2), bank(30, 500)],
      events: [ev(10, 45)],
    })
    // При банке 2 $ первый уровень (15%) округлился до нуля и ждёт денег, а
    // второй (30%) зафиксировался на 1 $. Пополнение до 502 $ фиксирует
    // первый, но не выше второго: уровень ниже не может стоить больше.
    const [first, second] = amounts(r)
    assert.equal(second, 1)
    assert.ok(first <= second, `первый ${first} $, второй ${second} $`)
    assert.equal(dollars(r.earnedCents), 1)
  })
})

describe('вершина без округления', () => {
  test('последний уровень — ровно весь банк, с центами', () => {
    const r = replayPrize({
      levels: SCALE,
      bankEntries: [{ id: 'b', occurredAt: at(0), amountCents: 1050 }],
      events: [ev(5, 100)],
    })
    assert.equal(r.earnedCents, 1050)
  })
})
