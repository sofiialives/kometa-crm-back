import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { AI_LIMITS, cut, fitPrompt, MAX_INPUT_CHARS, MAX_MESSAGE_CHARS, MAX_OUTPUT_TOKENS } from '../ai/limits.js'
import { ownerPrompt, STAFF_SCHEMA, staffPrompt, taskPrompt, TASK_SCHEMA } from '../ai/prompts.js'
import { untilFrom } from '../ai/agent.js'

describe('лимиты ИИ — бюджет $15 в месяц на 13 человек', () => {
  test('40 запросов на человека в день', () => {
    assert.equal(AI_LIMITS.own + AI_LIMITS.reply + AI_LIMITS.task, 40)
  })

  test('самый дорогой месяц укладывается: 13 человек × 40 × 31 × $0,0008 < $15', () => {
    const worstCall = (MAX_INPUT_CHARS / 2) * 0.10 / 1e6 + MAX_OUTPUT_TOKENS * 0.50 / 1e6
    assert.ok(worstCall <= 0.0008)
    assert.ok(13 * 40 * 31 * worstCall < 15)
  })
})

describe('размер запроса', () => {
  test('огромные данные и история не выходят за лимит', () => {
    const p = staffPrompt({ context: 'к'.repeat(50000), history: 'и'.repeat(50000), message: 'с'.repeat(5000) })
    assert.ok(p.system.length + p.user.length <= MAX_INPUT_CHARS + 300)
  })

  test('сообщение человека режется до 1000 символов', () => {
    const p = staffPrompt({ context: '', history: '', message: 'а'.repeat(5000) })
    assert.ok(p.user.includes('а'.repeat(MAX_MESSAGE_CHARS - 1)))
    assert.ok(!p.user.includes('а'.repeat(MAX_MESSAGE_CHARS + 1)))
  })

  test('данные CRM важнее истории: история уступает место первой', () => {
    const f = fitPrompt({ system: 'с', context: 'к'.repeat(11000), history: 'и'.repeat(5000), message: 'м' })
    assert.equal(f.context.length, 11000)
    assert.ok(f.history.length < 1000)
  })

  test('у Яна и у оценки задач тоже есть потолок', () => {
    const o = ownerPrompt({ context: 'к'.repeat(50000), history: '', message: 'кто отошёл?' })
    assert.ok(o.system.length + o.user.length <= MAX_INPUT_CHARS + 300)
    const t = taskPrompt({ title: 'т'.repeat(5000), description: 'о'.repeat(5000) })
    assert.ok(t.user.length <= MAX_MESSAGE_CHARS * 2)
  })

  test('cut не трогает короткое', () => {
    assert.equal(cut('коротко', 10), 'коротко')
  })
})

describe('схемы ответа — строгий JSON', () => {
  test('все поля обязательны, лишних нет', () => {
    for (const s of [STAFF_SCHEMA, TASK_SCHEMA]) {
      assert.equal(s.additionalProperties, false)
      assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort())
    }
  })
})

describe('время из ответа ИИ', () => {
  const now = new Date('2026-11-03T12:00:00+03:00')
  test('«ЧЧ:ММ» — сегодня в это время', () => {
    assert.equal(untilFrom({ until: '16:30', minutes: null }, now).toISOString(), new Date('2026-11-03T16:30:00+03:00').toISOString())
  })
  test('минуты — от сейчас', () => {
    assert.equal(untilFrom({ until: null, minutes: 40 }, now).toISOString(), new Date('2026-11-03T12:40:00+03:00').toISOString())
  })
  test('мусор, прошлое и больше 8 часов — без времени', () => {
    assert.equal(untilFrom({ until: 'скоро', minutes: null }, now), null)
    assert.equal(untilFrom({ until: '09:00', minutes: null }, now), null)
    assert.equal(untilFrom({ until: null, minutes: 600 }, now), null)
    assert.equal(untilFrom({ until: null, minutes: -5 }, now), null)
  })
})
