import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { sendOnce } from '../agent/notify.js'
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
