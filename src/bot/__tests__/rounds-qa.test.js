import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { drain, enqueue } from '../updates.js'
import { linksIn, reportText } from '../agent/rounds.js'
import { teamRequest } from '../parse.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

describe('остановка сервера при выкладке', () => {
  // drain включает флаг остановки на весь процесс, поэтому тест лежит в
  // отдельном файле: node --test гоняет каждый файл в своём процессе.
  test('drain ждёт начатый ответ, но не дольше срока', async () => {
    const order = []
    enqueue('qa-1', async () => { await sleep(60); order.push('ответил') })
    await drain(500)
    assert.deepEqual(order, ['ответил'])

    enqueue('qa-2', () => sleep(1500))
    const started = Date.now()
    await drain(100)
    assert.ok(Date.now() - started < 600, 'зависшее сообщение не держит остановку дольше срока')
  })
})

// Находки QA перед мержем агента: кириллица в границах слов, пустые
// пункты модели, ссылки на кириллических доменах.
describe('находки QA', () => {
  test('руководитель: «покажи задачи всех» это про людей, а не про его список', () => {
    assert.equal(teamRequest('покажи задачи всех'), true)
    assert.equal(teamRequest('что у всех по задачам'), true)
    assert.equal(teamRequest('всемирный день'), false)
  })

  test('отчёт: модель вернула пустые пункты, суть от агента не пропадает', () => {
    const at = new Date('2026-10-16T12:30:00Z')
    const text = reportText({
      round: { topic: 'т', sentAt: at },
      answered: [{ userId: 'a', label: '(Дизайн) Роман', summary: 'Делает баннер, готов наполовину', messages: [{ direction: 'in', text: 'Делаю баннер', createdAt: at }] }],
      silent: [],
      failed: [],
      ai: { a: { points: [], quote: null } },
    })
    assert.match(text, /Делает баннер, готов наполовину/)
  })

  test('ссылки в черновике: домен .рф тоже ссылка', () => {
    assert.deepEqual(linksIn(['глянь пример.рф']), ['пример.рф'])
    assert.deepEqual(linksIn(['bit.ly/abc, потом агентство.ru/x.']), ['bit.ly/abc', 'агентство.ru/x'])
    assert.deepEqual(linksIn(['файл отчёт.pdf в 15.30']), [])
  })
})
