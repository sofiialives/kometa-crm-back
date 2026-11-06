import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { prisma } from '../../config/prisma.js'
import { listIntent, tasksText } from '../agent/lists.js'
import { patch } from './patch.js'

// 4 ноября, 17:00 по Москве.
const NOW = new Date('2026-11-04T14:00:00Z')
const at = (iso) => new Date(iso)
const task = (extra = {}) => ({ id: 't', title: 'Макет', status: 'today', origin: 'personal', deadline: at('2026-11-04T16:00:00Z'), startAt: null, doneAt: null, work: null, ownerId: 'u1', ...extra })

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

describe('списки задач в боте без ИИ', () => {
  test('личные и по Иерархии отдельно, числа настоящие, остальное «и ещё»', async (t) => {
    patch(t, prisma.task, 'groupBy', async ({ where }) => {
      const m = where.AND[2]
      if (m.deadline?.lt === NOW) return [{ ownerId: 'u1', origin: 'personal', _count: 1 }, { ownerId: 'u1', origin: 'hierarchy', _count: 2 }]
      if (m.deadline?.gte?.getTime() === NOW.getTime()) return [{ ownerId: 'u1', origin: 'personal', _count: 22 }, { ownerId: 'u1', origin: 'hierarchy', _count: 1 }]
      if (m.deadline?.gte && !m.deadline.lt) return [{ ownerId: 'u1', origin: 'personal', _count: 2 }]
      return []
    })
    patch(t, prisma.task, 'findMany', async ({ where, take }) => {
      const origin = where.AND[1].origin
      return Array.from({ length: Math.min(take, origin === 'personal' ? 22 : 1) }, (_, i) => task({ id: `${origin}${i}`, title: `${origin} ${i}`, origin, work: origin === 'hierarchy' ? { title: 'Сайт', client: { name: 'Румикс' } } : null }))
    })
    const text = await tasksText('u1', NOW)
    assert.match(text, /<b>Личные задачи на сегодня, 22<\/b>/)
    assert.match(text, /И ещё 2 в CRM, во вкладке «Задачи»/)
    assert.match(text, /<b>Задачи по Иерархии на сегодня, 1<\/b>\n• hierarchy 0, клиент Румикс, до 19:00/)
    assert.match(text, /Со сроком на завтра и позже ещё личных 2$/m)
    assert.match(text, /<b>Личные просроченные задачи, 1<\/b>/)
    assert.match(text, /<b>Просроченные задачи по Иерархии, 2<\/b>/)
    assert.doesNotMatch(text, /срок прошёл/)
  })

  test('ничего на сегодня нет — так и сказано, один раз', async (t) => {
    patch(t, prisma.task, 'groupBy', async () => [])
    assert.equal(await tasksText('u1', NOW), '<b>Задач на сегодня нет</b>')
  })
})
