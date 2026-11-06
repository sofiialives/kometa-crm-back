import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { sendOnce, tellOwners } from '../agent/notify.js'
import { prisma } from '../../config/prisma.js'
import { patch } from './patch.js'
import { botHarness } from './harness.js'

describe('sendOnce при неясном ответе телеграма', () => {
  test('не дождались ответа (unsure): ключ остаётся, второй раз не шлём', async (t) => {
    const h = botHarness(t)
    let calls = 0
    const send = async () => { calls += 1; return { ok: false, retry: true, unsure: true } }
    await sendOnce('k1', send)
    assert.ok(h.notices.has('k1'), 'сообщение могло дойти, ключ занят')
    assert.equal((await sendOnce('k1', send)).skipped, true)
    assert.equal(calls, 1)
  })

  test('телеграм ответил ошибкой 5xx или 429: ключ освобождён, следующий проход повторит', async (t) => {
    const h = botHarness(t)
    let calls = 0
    const send = async () => { calls += 1; return calls === 1 ? { ok: false, retry: true, unsure: false } : { ok: true } }
    await sendOnce('k2', send)
    assert.ok(!h.notices.has('k2'))
    assert.equal((await sendOnce('k2', send)).ok, true)
    assert.equal(calls, 2)
  })
})

describe('отчёт двум владельцам', () => {
  const fetchBy = (t, byChat) => {
    const ok = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      const chat = JSON.parse(init.body).chat_id
      if (byChat[chat] === 'timeout') throw Object.assign(new Error('timeout'), { name: 'TimeoutError' })
      if (byChat[chat] === 'fail') return new Response(JSON.stringify({ ok: false }), { status: 500 })
      return ok(url, init)
    }
    t.after(() => { globalThis.fetch = ok })
  }

  test('одному таймаут, другому ошибка 500: повторяем, а не считаем дошедшим', async (t) => {
    botHarness(t)
    patch(t, prisma.user, 'findMany', async () => [{ id: 'a' }, { id: 'b' }])
    fetchBy(t, { 'chat-a': 'timeout', 'chat-b': 'fail' })
    const res = await tellOwners('отчёт')
    assert.equal(res.ok, false)
    assert.equal(res.retry, true)
    assert.equal(res.unsure, false)
  })

  test('обоим таймаут: могло дойти, повтора нет', async (t) => {
    botHarness(t)
    patch(t, prisma.user, 'findMany', async () => [{ id: 'a' }, { id: 'b' }])
    fetchBy(t, { 'chat-a': 'timeout', 'chat-b': 'timeout' })
    const res = await tellOwners('отчёт')
    assert.equal(res.unsure, true)
  })
})

