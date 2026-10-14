import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { splitText } from '../telegram.js'
import { bankLine, eventLine, reviewButtons } from '../agent/feed.js'

describe('длинные сообщения', () => {
  test('короткое — одним куском', () => {
    assert.deepEqual(splitText('привет'), ['привет'])
  })

  test('длинное режется по строкам, каждый кусок в пределах', () => {
    const text = Array.from({ length: 200 }, (_, i) => `• строка номер ${i} с ответом на чек-ин`).join('\n')
    const parts = splitText(text, 1000)
    assert.ok(parts.length > 1)
    for (const p of parts) assert.ok(p.length <= 1000)
    assert.equal(parts.join('\n'), text)
  })

  test('одна огромная строка обрезается, а не теряет сообщение', () => {
    const parts = splitText('а'.repeat(5000), 1000)
    assert.equal(parts.length, 1)
    assert.ok(parts[0].length <= 1000)
  })
})

describe('лента для сотрудника', () => {
  test('списание — без минуса перед суммой', () => {
    assert.equal(bankLine({ kind: 'write_off', amountCents: -5000, comment: null }), '💸 Из банка списано $50')
  })

  test('пополнение с причиной и клиентом, текст экранирован', () => {
    assert.equal(bankLine({ kind: 'top_up', amountCents: 2550, reason: 'new_client', clientName: 'A<B' }), '💰 Банк пополнен на $25,5\nНовый клиент «A&lt;B»')
  })

  test('корректировка только уровня — без «0 баллов»', () => {
    assert.equal(eventLine({ prizePoints: 0, levelPoints: 3, title: 'Ручная корректировка' }), '📈 +3 к уровню работы\nРучная корректировка')
    assert.equal(eventLine({ prizePoints: 0, levelPoints: 0, title: 'Пусто' }), null)
  })

  test('пропуск звонка — человеческим текстом', () => {
    assert.match(eventLine({ prizePoints: -1, levelPoints: -1, title: 'Пропустил звонок', eventType: { systemKey: 'call_missed' } }), /не было на вечернем звонке, −1 балл/)
  })

  test('баллы за задачу — с названием, без HTML от человека', () => {
    assert.equal(eventLine({ prizePoints: 2, levelPoints: 2, title: 'Задача в срок', taskTitle: '<b>Лендинг</b>' }), '⭐ +2 балла\nЗадача в срок «&lt;b&gt;Лендинг&lt;/b&gt;»')
  })
})

describe('кнопки заявки у Яна', () => {
  test('штраф — «Снять», с числом, которое Ян видел', () => {
    const [[yes, no]] = reviewButtons({ id: 'r1', prizePoints: -4 })
    assert.equal(yes.text, 'Снять −4 балла')
    assert.equal(yes.data, 'rv:a:r1:-4')
    assert.equal(no.text, 'Не снимать')
  })
})
