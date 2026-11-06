import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { prisma } from '../../config/prisma.js'
import { sendPart, sendRoundReport } from '../agent/rounds.js'
import { sendMessage } from '../telegram.js'
import { patch } from './patch.js'

const roman = { id: 'roman', name: 'Роман Котов', role: 'staff', departmentId: 'd', department: { name: 'Дизайн' } }
const at = new Date('2026-11-04T10:00:00Z')

/**
 * База и телеграм для отчёта. responses — что отвечает телеграм на sendMessage
 * по очереди: 'ok', 'timeout' или 'fail' (явная ошибка 500). Остальное
 * (фото) всегда принимает. Возвращает вызовы и состояние.
 */
function setup(t, { responses = ['ok'] } = {}) {
  const notices = new Set()
  patch(t, prisma.botNotice, 'findUnique', async ({ where }) => (notices.has(where.key) ? { key: where.key } : null))
  patch(t, prisma.botNotice, 'create', async ({ data }) => {
    if (notices.has(data.key)) throw Object.assign(new Error('dup'), { code: 'P2002' })
    notices.add(data.key)
    return data
  })
  patch(t, prisma.botNotice, 'delete', async ({ where }) => { notices.delete(where.key); return {} })
  const state = { status: 'sent', reportTries: 0 }
  patch(t, prisma.botRound, 'updateMany', async ({ where, data }) => {
    if (where.status !== state.status) return { count: 0 }
    state.status = data.status
    return { count: 1 }
  })
  patch(t, prisma.botRound, 'findUnique', async () => ({
    id: 'r1', ownerId: 'owner', collect: true, topic: 'Как дела', sentAt: at, reportText: 'Отчёт по опросу', reportTries: state.reportTries, owner: { id: 'owner', role: 'admin' },
  }))
  patch(t, prisma.botRound, 'update', async ({ data }) => {
    if (data.status) state.status = data.status
    if (data.reportTries) state.reportTries += 1
    return {}
  })
  patch(t, prisma.telegramLink, 'findFirst', async () => ({ chatId: '9001' }))
  patch(t, prisma.botMessage, 'create', async () => ({ id: 'm' }))
  patch(t, prisma.botRoundTarget, 'findMany', async () => [{
    userId: 'roman', user: roman, status: 'answered', summary: 'Баннер почти готов', text: 'Роман, как баннер?',
    messages: [{ direction: 'in', text: 'Вот макет', createdAt: at, fileId: 'f1', fileKind: 'photo', fileMime: 'image/jpeg', source: null }],
  }])
  const sent = []
  const script = [...responses]
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const method = String(url).split('/').pop()
    sent.push(method)
    if (method !== 'sendMessage') return new Response(JSON.stringify({ ok: true, result: {} }))
    const next = script.shift() ?? 'ok'
    if (next === 'timeout') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    if (next === 'fail') return new Response(JSON.stringify({ ok: false, description: 'Internal Server Error' }), { status: 500 })
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }))
  }
  t.after(() => { globalThis.fetch = realFetch })
  return { notices, state, sent }
}

describe('отчёт по поручению не дублируется', () => {
  test('телеграм не ответил за 15 секунд — отчёт мог дойти, второй раз не шлём', async (t) => {
    const ctx = setup(t, { responses: ['timeout'] })
    const first = await sendRoundReport('r1')
    assert.equal(first.ok, true)
    assert.equal(ctx.state.status, 'closed')
    assert.equal(ctx.sent.filter((m) => m === 'sendMessage').length, 1)
    assert.equal(ctx.sent.filter((m) => m === 'sendPhoto').length, 1)
    // Отчёт «застрял» и взят снова: уже ушедшие части не уходят.
    ctx.state.status = 'sent'
    await sendRoundReport('r1')
    assert.equal(ctx.sent.filter((m) => m === 'sendMessage').length, 1)
    assert.equal(ctx.sent.filter((m) => m === 'sendPhoto').length, 1)
  })

  test('явная ошибка телеграма — часть можно повторить, и она уходит один раз', async (t) => {
    const ctx = setup(t, { responses: ['fail', 'ok'] })
    const first = await sendRoundReport('r1')
    assert.deepEqual([first.ok, first.reason], [false, 'telegram'])
    assert.equal(ctx.state.status, 'sent')
    assert.equal(ctx.state.reportTries, 1)
    assert.equal(ctx.notices.has('round-report:r1:text'), false)
    await sendRoundReport('r1')
    assert.equal(ctx.state.status, 'closed')
    assert.equal(ctx.sent.filter((m) => m === 'sendMessage').length, 2)
    assert.equal(ctx.sent.filter((m) => m === 'sendPhoto').length, 1)
    ctx.state.status = 'sent'
    await sendRoundReport('r1')
    assert.equal(ctx.sent.filter((m) => m === 'sendMessage').length, 2)
  })

  test('текст ушёл, а перед файлами процесс упал — после сброса текст не повторится, файлы дойдут', async (t) => {
    const ctx = setup(t)
    ctx.notices.add('round-report:r1:text')
    await sendRoundReport('r1')
    assert.equal(ctx.sent.filter((m) => m === 'sendMessage').length, 0)
    assert.equal(ctx.sent.filter((m) => m === 'sendPhoto').length, 1)
    assert.equal(ctx.state.status, 'closed')
  })

  test('часть: уже ушла — пропуск; ушла или могла уйти — отмечена отправленной', async (t) => {
    const ctx = setup(t)
    let n = 0
    assert.deepEqual(await sendPart('x', 'a', async () => { n += 1; return { ok: true } }), { ok: true })
    assert.deepEqual(await sendPart('x', 'a', async () => { n += 1; return { ok: true } }), { ok: true, skipped: true })
    assert.equal(n, 1)
    assert.equal(ctx.notices.has('round-report:x:a'), true)
    const timedOut = await sendPart('x', 'c', async () => ({ ok: false, retry: true, unsure: true }))
    assert.equal(timedOut.unsure, true)
    assert.equal(ctx.notices.has('round-report:x:c'), true)
    await sendPart('x', 'd', async () => ({ ok: false, retry: false }))
    assert.equal(ctx.notices.has('round-report:x:d'), false)
  })

  test('явная ошибка доставки возвращает попытку, отметки «отправлено» нет', async (t) => {
    const ctx = setup(t)
    await sendPart('x', 'e', async () => ({ ok: false, retry: true }))
    assert.equal(ctx.notices.has('round-report:x:e'), false)
    assert.equal(ctx.notices.has('round-report:x:e:try:1'), false)
    let n = 0
    await sendPart('x', 'e', async () => { n += 1; return { ok: true } })
    assert.equal(n, 1)
  })

  test('отправка бросила исключение — попытка возвращается, а не съедается', async (t) => {
    const ctx = setup(t)
    await assert.rejects(sendPart('x', 'f', async () => { throw new Error('сеть') }))
    assert.equal(ctx.notices.has('round-report:x:f:try:1'), false)
    assert.equal(ctx.notices.has('round-report:x:f'), false)
    let n = 0
    assert.deepEqual(await sendPart('x', 'f', async () => { n += 1; return { ok: true } }), { ok: true })
    assert.equal(n, 1)
  })

  test('все попытки оборвались — честно «не доставлен», без новой отправки', async (t) => {
    const ctx = setup(t)
    for (let i = 1; i <= 5; i += 1) ctx.notices.add(`round-report:x:g:try:${i}`)
    let n = 0
    const res = await sendPart('x', 'g', async () => { n += 1; return { ok: true } })
    assert.equal(res.exhausted, true)
    assert.equal(n, 0)
  })

  test('прошлая попытка оборвалась на захвате — часть отправляется ещё раз и отмечается', async (t) => {
    const ctx = setup(t)
    ctx.notices.add('round-report:r1:text:try:1')
    const first = await sendRoundReport('r1')
    assert.equal(first.ok, true)
    assert.equal(ctx.sent.filter((m) => m === 'sendMessage').length, 1)
    assert.equal(ctx.notices.has('round-report:r1:text'), true)
    assert.equal(ctx.notices.has('round-report:r1:text:try:2'), true)
    // Теперь отмечена отправленной: сброс застрявшего отчёта текст не повторит.
    ctx.state.status = 'sent'
    await sendRoundReport('r1')
    assert.equal(ctx.sent.filter((m) => m === 'sendMessage').length, 1)
  })

  test('попытки оборвались все пять раз — шестой нет, отчёт закрывается', async (t) => {
    const ctx = setup(t)
    for (let n = 1; n <= 5; n += 1) ctx.notices.add(`round-report:r1:text:try:${n}`)
    const res = await sendRoundReport('r1')
    assert.equal(res.ok, false)
    assert.equal(ctx.sent.filter((m) => m === 'sendMessage').length, 0)
    assert.equal(ctx.state.status, 'closed')
  })
})

describe('телеграм: не дождались ответа и ответили ошибкой — разные случаи', () => {
  test('таймаут — сообщение могло дойти (unsure), 500 — нет', async (t) => {
    const realFetch = globalThis.fetch
    t.after(() => { globalThis.fetch = realFetch })
    globalThis.fetch = async () => { throw new DOMException('timeout', 'TimeoutError') }
    assert.deepEqual(await sendMessage('1', 'текст'), { ok: false, retry: true, unsure: true })
    globalThis.fetch = async () => { throw new TypeError('fetch failed') }
    assert.deepEqual(await sendMessage('1', 'текст'), { ok: false, retry: true, unsure: false })
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, description: 'boom' }), { status: 500 })
    assert.deepEqual(await sendMessage('1', 'текст'), { ok: false, retry: true, unsure: false })
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, description: 'blocked' }), { status: 403 })
    assert.deepEqual(await sendMessage('1', 'текст'), { ok: false, retry: false, unsure: false })
  })
})
