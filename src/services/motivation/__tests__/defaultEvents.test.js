import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DEFAULT_EVENTS } from '../settings.service.js'

// Список Яна от 9.11: эти события стоят у каждого по умолчанию.
const YAN = [
  ['Клиент купил дополнительный продукт', 10],
  ['Был на вечернем звонке', 1],
  ['Пропустил звонок', -2],
  ['Не ответил на внезапный чек-ин', -3],
  ['Задача из Иерархии закрыта в срок', 5],
  ['Личная задача закрыта в срок', 1],
  ['Просрочена личная задача', -2],
  ['Просрочена задача из Иерархии', -2],
  ['Больше 45 минут нет ответа агенту без предупреждения', -3],
  ['Больше 45 минут нет ответа Яну без предупреждения', -3],
  ['После 10:00 не стоит ни одной задачи', -2],
  ['Прочие плюсы', 1],
  ['Прочие минусы', -1],
  ['Задача отмечена выполненной, а по факту нет', -10],
]

describe('события по умолчанию', () => {
  test('весь список Яна в его порядке, с его суммами', () => {
    const titles = DEFAULT_EVENTS.map((e) => e.title)
    let last = -1
    for (const [title, points] of YAN) {
      const i = titles.indexOf(title)
      assert.ok(i > last, `«${title}» на месте и по порядку`)
      assert.equal(DEFAULT_EVENTS[i].points, points, title)
      last = i
    }
  })

  test('«баллы начисляю сам»: задачи в срок и просрочки на решение, «после 10:00» сразу', () => {
    const rule = (r) => DEFAULT_EVENTS.find((e) => e.autoRule === r)
    for (const r of ['task_on_time', 'personal_task_on_time', 'task_overdue', 'personal_task_overdue']) assert.equal(rule(r).review, true, r)
    assert.equal(rule('tasks_not_set').review, false)
  })

  test('миграция для старых профилей дописывает тот же список', () => {
    const sql = readFileSync(new URL('../../../../prisma/migrations/20261111110000_default_events/migration.sql', import.meta.url), 'utf8')
    for (const e of DEFAULT_EVENTS) assert.ok(sql.includes(`'${e.title}'`), e.title)
  })
})
