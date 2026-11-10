import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { roundTools, staffTools, styleTools, teamTools } from '../ai/tools.js'
import { toolDefs } from '../ai/engine.js'

// API Anthropic не принимает строгие схемы, где полей с union-типом (anyOf или
// type-массив) больше 16 на запрос: весь ход падает с 400. Так 6.11 сломались
// все запросы руководителя после assign_task. Считаем с запасом.
const LIMIT = 16

function unions(tools) {
  let n = 0
  const walk = (s) => {
    if (!s || typeof s !== 'object') return
    if (Array.isArray(s.type) || s.anyOf) n += 1
    for (const v of Object.values(s.properties ?? {})) walk(v)
    if (s.items) walk(s.items)
  }
  for (const t of tools) walk(t.input_schema)
  return n
}

describe('схемы инструментов в пределах лимита API', () => {
  const ctx = (role) => ({ user: { id: 'x', role, departmentId: 'd' }, chatId: '1', now: new Date(), text: '' })
  const target = { id: 't', status: 'sent', round: { owner: { role: 'admin' } } }

  test('Ян', () => {
    const c = ctx('admin')
    assert.ok(unions([...teamTools(c), ...styleTools(c)]) <= LIMIT)
  })

  test('руководитель со всем набором, и в разговоре по поручению', () => {
    const c = ctx('lead')
    const n = unions([...staffTools(c), ...styleTools(c), ...teamTools(c, { team: true }), ...roundTools(c, target)])
    assert.ok(n <= LIMIT, `полей с union ${n}`)
  })

  test('сотрудник в разговоре по поручению', () => {
    const c = ctx('staff')
    assert.ok(unions([...staffTools(c), ...styleTools(c), ...roundTools(c, target)]) <= LIMIT)
  })
})

// Строгих инструментов API принимает не больше 20 на запрос. 10.11 у
// руководителя их стало 21, и каждый его ход в опросе падал с 400.
describe('строгих инструментов не больше 20', () => {
  const c = { user: { id: 'x', role: 'lead', departmentId: 'd' }, chatId: '1', now: new Date(), text: '' }
  const target = { id: 't', status: 'sent', round: { owner: { role: 'admin' } } }
  test('руководитель со всем набором в разговоре по поручению', () => {
    const defs = toolDefs([...staffTools(c), ...styleTools(c), ...teamTools(c, { team: true }), ...roundTools(c, target)])
    const strict = defs.filter((d) => d.strict).length
    assert.ok(strict <= 20, `строгих ${strict}`)
  })
  test('инструмент без полей не строгий, с полями строгий', () => {
    const defs = toolDefs(staffTools(c))
    assert.equal(defs.find((d) => d.name === 'come_back').strict, false)
    assert.equal(defs.find((d) => d.name === 'set_task_status').strict, true)
  })
})
