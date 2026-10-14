import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { reminderText } from '../agent/remind.js'

describe('текст напоминания', () => {
  test('без «напомни мне» и времени', () => {
    assert.equal(reminderText('напомни мне в 15:00 позвонить клиенту'), 'позвонить клиенту')
    assert.equal(reminderText('Напомни через 20 минут про отчёт'), 'отчёт')
    assert.equal(reminderText('напомни, что надо отправить счёт'), 'надо отправить счёт')
    assert.equal(reminderText('через 20 минут напомни про отчёт'), 'отчёт')
    assert.equal(reminderText('напомни завтра в 10:00 про звонок'), 'звонок')
    assert.equal(reminderText('напомни в 10 завтра позвонить Олегу'), 'позвонить Олегу')
  })
  test('пустое — понятная заглушка', () => {
    assert.equal(reminderText('напомни'), 'то, о чём просил(а)')
  })
})
