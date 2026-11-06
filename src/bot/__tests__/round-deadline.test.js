import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { prisma } from '../../config/prisma.js'
import { createDraft, setRoundDeadline } from '../agent/rounds.js'
import { teamTools } from '../ai/tools.js'
import { ownerSystem, staffSystem } from '../ai/system.js'
import { patch } from './patch.js'

const NOW = new Date('2026-11-04T14:00:00Z')
const owner = { id: 'owner', role: 'admin' }
const denis = { id: 'denis', name: 'Денис Лебедев', role: 'staff', active: true, departmentId: 'd', department: { name: 'SMM' }, telegram: { chatId: '1002' } }
const running = { id: 'r-old', topic: 'Как дела по задачам', deadlineAt: new Date('2026-11-04T15:00:00Z'), targets: [{ userId: 'denis' }] }
const draft = { topic: 'Как дела', minutes: 60, collect: true, messages: [{ person_id: 'denis', text: 'Денис, привет. Как дела?' }] }

describe('один отчёт: срок меняем, а не заводим новое поручение', () => {
  test('срок идущего поручения: от сейчас, своё, не короче 10 минут и не дольше 8 часов', async (t) => {
    const found = patch(t, prisma.botRound, 'findFirst', async () => ({ id: 'r1' }))
    const changed = patch(t, prisma.botRound, 'updateMany', async () => ({ count: 1 }))
    const text = await setRoundDeadline(owner, null, 30, NOW)
    assert.match(text, /Срок отчёта теперь 17:30\. Скажи об этом коротко\. Новое поручение не создавай/)
    assert.deepEqual(found[0][0].where, { ownerId: 'owner', status: 'sent', collect: true })
    assert.deepEqual(changed[0][0], { where: { id: 'r1', status: 'sent' }, data: { deadlineAt: new Date('2026-11-04T14:30:00Z') } })
    await setRoundDeadline(owner, 'r1', 1, NOW)
    assert.equal(changed[1][0].data.deadlineAt.toISOString(), '2026-11-04T14:10:00.000Z')
    await setRoundDeadline(owner, 'r1', 5000, NOW)
    assert.equal(changed[2][0].data.deadlineAt.toISOString(), '2026-11-04T22:00:00.000Z')
    assert.deepEqual(found[1][0].where, { ownerId: 'owner', status: 'sent', collect: true, id: 'r1' })
  })

  test('нет идущего поручения или отчёт уже собирается — срок не меняем', async (t) => {
    patch(t, prisma.botRound, 'findFirst', async () => null)
    assert.match(await setRoundDeadline(owner, null, 30, NOW), /Идущего поручения с отчётом нет/)
    patch(t, prisma.botRound, 'findFirst', async () => ({ id: 'r1' }))
    patch(t, prisma.botRound, 'updateMany', async () => ({ count: 0 }))
    assert.match(await setRoundDeadline(owner, null, 30, NOW), /Отчёт уже собирается/)
  })

  test('инструмент есть у владельца и руководителя, вызывает ту же функцию, схема строгая', async (t) => {
    const found = patch(t, prisma.botRound, 'findFirst', async () => ({ id: 'r1' }))
    patch(t, prisma.botRound, 'updateMany', async () => ({ count: 1 }))
    const tool = teamTools({ user: owner, chatId: '9001', now: NOW }).find((x) => x.name === 'set_round_deadline')
    assert.ok(tool)
    assert.deepEqual(tool.input_schema.required, ['minutes', 'round_id'])
    assert.match(await tool.run({ minutes: 30, round_id: null }), /17:30/)
    assert.equal(found[0][0].where.ownerId, 'owner')
    const messagePeople = teamTools({ user: owner, chatId: '9001', now: NOW }).find((x) => x.name === 'message_people')
    assert.ok(messagePeople.input_schema.required.includes('new_round'))
  })

  test('подсказка: на «пришли отчёт через N минут» менять срок', () => {
    for (const text of [ownerSystem(), staffSystem({ lead: true })]) {
      assert.match(text, /set_round_deadline/)
      assert.match(text, /меняй срок, а не создавай новое поручение/)
    }
  })

  test('подсказка: не обещать «допишу» и «пришлю позже», сводка по поручению только по просьбе', () => {
    for (const text of [ownerSystem(), staffSystem(), staffSystem({ lead: true })]) {
      assert.match(text, /Не обещай «допишу», «пришлю позже»/)
    }
    assert.match(ownerSystem(), /get_round, но только когда об этом просят/)
  })

  test('message_people тем же людям, пока поручение идёт — ошибка с подсказкой, черновика нет', async (t) => {
    patch(t, prisma.user, 'findFirst', async () => denis)
    const asked = patch(t, prisma.botRound, 'findMany', async () => [running])
    const created = patch(t, prisma.botRound, 'create', async () => ({ id: 'r-new' }))
    const res = await createDraft(owner, '9001', draft, NOW)
    assert.equal(res.shown, false)
    assert.match(res.text, /Тем же людям \(Денис, SMM\) уже идёт поручение «Как дела по задачам», id r-old, сбор до 18:00/)
    assert.match(res.text, /set_round_deadline/)
    assert.match(res.text, /new_round true/)
    assert.equal(created.length, 0)
    assert.deepEqual(asked[0][0].where.targets.some.userId, { in: ['denis'] })
    assert.equal(asked[0][0].where.ownerId, 'owner')
  })

  test('явное «новое поручение» (new_round) и рассылка без отчёта — проходят дальше', async (t) => {
    patch(t, prisma.user, 'findFirst', async () => denis)
    const asked = patch(t, prisma.botRound, 'findMany', async () => [running])
    patch(t, prisma.task, 'findMany', async () => [])
    patch(t, prisma.botRound, 'updateMany', async () => ({ count: 0 }))
    const created = patch(t, prisma.botRound, 'create', async () => ({ id: 'r-new', collect: true }))
    patch(t, prisma.botRound, 'update', async () => ({}))
    patch(t, prisma.botMessage, 'create', async () => ({ id: 'm' }))
    const realFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }))
    t.after(() => { globalThis.fetch = realFetch })
    const forced = await createDraft(owner, '9001', { ...draft, new_round: true }, NOW)
    assert.equal(forced.shown, true)
    const plain = await createDraft(owner, '9001', { ...draft, collect: false }, NOW)
    assert.equal(plain.shown, true)
    assert.equal(created.length, 2)
    assert.equal(asked.length, 0)
  })
})
