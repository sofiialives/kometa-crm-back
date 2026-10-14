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
  test('единицы времени по-русски целиком — без хвостов вроде «ы»', () => {
    assert.equal(reminderText('напомни через 2 минуты проверить почту'), 'проверить почту')
    assert.equal(reminderText('напомни через 1 минуту позвонить'), 'позвонить')
    assert.equal(reminderText('напомни через 3 часа отправить отчёт'), 'отправить отчёт')
    assert.equal(reminderText('напомни через 5 мин. закрыть задачу'), 'закрыть задачу')
    assert.equal(reminderText('напомни через полчаса проверить почту'), 'проверить почту')
  })
  test('вежливость и связки', () => {
    assert.equal(reminderText('напомни пожалуйста через 2 часа отправить отчёт'), 'отправить отчёт')
    assert.equal(reminderText('Напомни через 3 часа о том, что нужно оплатить'), 'нужно оплатить')
    assert.equal(reminderText('напомни завтра в 9:00, что встреча'), 'встреча')
  })
  test('«в офисе» — не время, не режем', () => {
    assert.equal(reminderText('напомни в офисе взять ключи'), 'в офисе взять ключи')
  })
  test('пустое — понятная заглушка', () => {
    assert.equal(reminderText('напомни'), 'То, о чём договорились')
  })
})
