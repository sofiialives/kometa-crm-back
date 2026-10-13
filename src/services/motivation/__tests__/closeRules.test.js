import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { monthsToClose, snapshotEmployee, snapshotRow, snapshotWork, sortByName } from '../closeRules.js'

describe('какие месяцы закрыть', () => {
  test('все прошлые от первого месяца мотивации, текущий — никогда', () => {
    assert.deepEqual(monthsToClose('2026-09', '2026-12'), ['2026-09', '2026-10', '2026-11'])
  })

  test('уже закрытые пропускаются', () => {
    assert.deepEqual(monthsToClose('2026-09', '2026-12', new Set(['2026-09', '2026-11'])), ['2026-10'])
  })

  test('мотивация началась в текущем месяце — закрывать нечего', () => {
    assert.deepEqual(monthsToClose('2026-10', '2026-10'), [])
  })

  test('через новый год', () => {
    assert.deepEqual(monthsToClose('2026-11', '2027-02'), ['2026-11', '2026-12', '2027-01'])
  })

  test('мотивации ещё не было — закрывать нечего', () => {
    assert.deepEqual(monthsToClose(null, '2026-10'), [])
  })
})

describe('снимок', () => {
  test('в снимок не попадает фото — оно берётся нынешнее', () => {
    const card = snapshotEmployee({ id: 'u1', name: 'Николай', avatarUrl: 'data:image/png;base64,AAAA', avatarColor: '#fff' })
    assert.equal(card.avatarUrl, undefined)
    assert.equal(card.avatarColor, '#fff')
    assert.equal(snapshotRow({ employee: card, work: null }, 'новое-фото').employee.avatarUrl, 'новое-фото')
  })

  test('уровень работы хранится целиком, а в строке таблицы — номер и название', () => {
    const work = { levels: [{ position: 1 }], current: { position: 2, title: 'Хороший темп' }, next: { position: 3 }, pointsLeft: 10 }
    const stored = snapshotWork(work)
    assert.deepEqual(stored.current, work.current)
    assert.deepEqual(stored.levels, work.levels)
    assert.deepEqual(snapshotRow({ employee: { name: 'А' }, work: stored }).work, { position: 2, title: 'Хороший темп' })
  })

  test('строки снимка — по имени', () => {
    const rows = sortByName([{ employee: { name: 'Роман' } }, { employee: { name: 'Анна' } }, { employee: { name: 'Игорь' } }])
    assert.deepEqual(rows.map((r) => r.employee.name), ['Анна', 'Игорь', 'Роман'])
  })
})
