import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { listIntent } from '../agent/lists.js'

describe('просьба показать список', () => {
  test('задачи и звонки на сегодня', () => {
    for (const t of ['что у меня на сегодня?', 'Что на сегодня', 'мои задачи и звонки']) assert.equal(listIntent(t), 'today', t)
  })
  test('только задачи', () => {
    for (const t of ['мои задачи', 'какие у меня задачи?', 'что по задачам', 'задачи на сегодня', 'сколько у меня задач']) assert.equal(listIntent(t), 'tasks', t)
  })
  test('только звонки', () => {
    for (const t of ['что у меня по звонкам?', 'есть сегодня звонки?', 'когда звонок']) assert.equal(listIntent(t), 'calls', t)
  })
  test('остальное — не список', () => {
    for (const t of ['отхожу на 20 минут', 'привет, как дела', 'что думаешь о моих задачах', '']) assert.equal(listIntent(t), null, t)
  })
})
