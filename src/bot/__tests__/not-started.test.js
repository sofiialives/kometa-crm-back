import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { prisma } from '../../config/prisma.js'
import { env } from '../../config/env.js'
import { nudgeText } from '../ai/nudge.js'
import { notStartedText, tickNotStarted } from '../agent/tasks.js'
import { botHarness } from './harness.js'
import { patch } from './patch.js'

const T = (time) => new Date(`2026-11-03T${time}:00+03:00`)
const NOW = T('12:20')
const owner = { id: 'u1', name: 'Антон Иванов', role: 'staff' }
const task = (id) => ({ id, title: `Задача ${id}`, startAt: T('12:00'), createdAt: T('09:00'), ownerId: 'u1', owner })

/** Всё, что читает tickNotStarted; working — есть ли у человека работа в процессе. */
function setup(t, { working = false, tasks = [task('a'), task('b')] } = {}) {
  const h = botHarness(t)
  // Без ключа ИИ выключен: вопрос уходит шаблоном.
  const key = env.anthropicApiKey
  env.anthropicApiKey = ''
  t.after(() => { env.anthropicApiKey = key })
  patch(t, prisma.task, 'findMany', async () => tasks)
  patch(t, prisma.motivationAway, 'findFirst', async () => null)
  patch(t, prisma.botEvent, 'findMany', async () => [])
  patch(t, prisma.botEvent, 'create', async () => ({}))
  const asked = []
  patch(t, prisma.task, 'findFirst', async (q) => { asked.push(q.where); return working ? { id: 'x' } : null })
  patch(t, prisma.user, 'findMany', async () => [{ id: 'owner' }])
  return { h, asked }
}

describe('«эти задачи должны были начаться»', () => {
  test('шаблон без ИИ: названия строками, без маркеров, точек и двоеточий', () => {
    assert.equal(notStartedText([task('a'), task('b')], T('12:00')), 'Эти задачи должны были начаться в <b>12:00</b>\n«Задача a»\n«Задача b»\nКак дела?')
    assert.equal(notStartedText([task('a')], T('12:00')), '«Задача a» должна была начаться в <b>12:00</b>\nКак дела?')
  })

  test('никто ничего не взял: Яну отчёт, человеку шаблон с кнопками (ИИ нет)', async (t) => {
    const { h } = setup(t)
    await tickNotStarted(NOW)
    const toUser = h.sent.find((m) => m.chatId === 'chat-u1')
    assert.match(toUser.text, /^Эти задачи должны были начаться в <b>12:00<\/b>/)
    assert.deepEqual(toUser.buttons.map((r) => r[0].callback_data), ['tk:go:a', 'tk:go:b', 'tk:late:a'])
    assert.ok(h.sent.some((m) => m.chatId === 'chat-owner' && m.text.includes('Задачи не начаты вовремя')))
  })

  test('взял в работу задачу группы или что-то уже в процессе: ни вопроса, ни отчёта, ни баллов', async (t) => {
    const { h, asked } = setup(t, { working: true })
    await tickNotStarted(NOW)
    assert.equal(h.sent.length, 0)
    assert.equal(h.logged.length, 0)
    // Проверка смотрит и на эту группу (progress/done), и на любую задачу в процессе за сегодня.
    const or = asked[0].OR
    assert.deepEqual(or[0].status, { in: ['progress', 'done'] })
    assert.equal(or[0].startAt.getTime(), T('12:00').getTime())
    assert.equal(or[1].status, 'progress')
  })
})

describe('текст вопроса пишет агент', () => {
  const base = { user: owner, titles: ['Макет'], startAt: T('12:00'), minutes: 20, now: NOW }
  const deps = (text, seen = []) => ({
    pick: async () => ({ model: 'claude-sonnet-5-5' }), can: async () => true, take: async () => true, record: async () => {},
    brief: 'Антон', rows: [], shared: '', personal: '',
    create: async (p) => { seen.push(p); return { stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: 1 } } },
  })

  test('один запрос без инструментов, вид nudge, ответ приведён к стилю', async () => {
    const seen = []
    const text = await nudgeText(base, deps('Антон, как там «Макет»!\n- застрял на чём?', seen))
    assert.equal(text, 'Антон, как там «Макет»\nзастрял на чём?')
    assert.equal(seen.length, 1)
    assert.equal(seen[0].tools, undefined)
    assert.match(seen[0].system[0].text, /Как писать/)
    assert.match(JSON.stringify(seen[0].messages), /«Макет»/)
  })

  test('лимит, бюджет, пустой ответ и ссылка — шаблон или чистый текст', async () => {
    assert.equal(await nudgeText(base, { ...deps('Привет'), take: async () => false }), null)
    assert.equal(await nudgeText(base, { ...deps('Привет'), can: async () => false }), null)
    assert.equal(await nudgeText(base, { ...deps('Привет'), pick: async () => ({ model: null, why: 'day' }) }), null)
    assert.equal(await nudgeText(base, deps('   ')), null)
    assert.equal(await nudgeText(base, deps('Глянь t.me/x')), 'Глянь [ссылка]')
  })
})
