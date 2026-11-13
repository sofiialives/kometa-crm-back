import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { prisma } from '../../config/prisma.js'
import { penalizeNoReply, tickRounds } from '../agent/rounds.js'
import { botHarness } from './harness.js'
import { patch } from './patch.js'

const SENT = new Date('2026-11-13T07:03:00Z')
const types = [
  { id: 'ck', systemKey: 'checkin_missed', enabled: true, title: 'Не ответил на внезапный чек-ин', prizePoints: -3, levelPoints: -3 },
  { id: 'nr', systemKey: 'agent_no_reply', enabled: true, title: 'Больше 45 минут нет ответа агенту без предупреждения', prizePoints: -5, levelPoints: -5 },
]

function world(t) {
  const h = botHarness(t)
  const created = []
  patch(t, prisma.motivationAway, 'findFirst', async () => null)
  patch(t, prisma.motivationEvent, 'findUnique', async () => null)
  patch(t, prisma.motivationEvent, 'create', async ({ data }) => { created.push(data); return data })
  patch(t, prisma.motivationAssignment, 'findFirst', async () => ({ profileId: 'p1', profile: { eventTypes: types } }))
  return { h, created }
}

describe('штраф за молчание агенту', () => {
  test('Ян попросил чек-ин: снимаем по правилу «Не ответил на внезапный чек-ин»', async (t) => {
    const { h, created } = world(t)
    const round = { topic: 'Внезапный чек-ин, кто чем занят', sentAt: SENT, deadlineAt: new Date(SENT.getTime() + 10 * 60000) }
    await penalizeNoReply({ id: 'tg1', userId: 'u1', sentAt: SENT, text: 'Чем занят?' }, new Date(SENT.getTime() + 10 * 60000), round)
    assert.equal(created.length, 1)
    assert.equal(created[0].eventTypeId, 'ck')
    assert.equal(created[0].prizePoints, -3)
    assert.match(created[0].comment, /ответа не было 10 минут/)
    // Яну отдельным сообщением не пишем: он получит общий список автоначислений.
    assert.equal(h.sent.length, 0)
  })

  test('обычное поручение: «нет ответа агенту», ждём не дольше 45 минут', async (t) => {
    const { created } = world(t)
    const round = { topic: 'Как дела с баннером', sentAt: SENT, deadlineAt: new Date(SENT.getTime() + 120 * 60000) }
    await penalizeNoReply({ id: 'tg2', userId: 'u1', sentAt: SENT, text: 'Как баннер?' }, new Date(SENT.getTime() + 46 * 60000), round)
    assert.equal(created[0].eventTypeId, 'nr')
    assert.match(created[0].comment, /45 минут/)
  })

  test('тик: в срок опроса на 10 минут снимает молчащим, ответившим нет', async (t) => {
    const { created } = world(t)
    const round = {
      id: 'r1', kind: 'ask', status: 'sent', collect: true, topic: 'Внезапный чек-ин', sentAt: SENT, deadlineAt: new Date(SENT.getTime() + 10 * 60000), nudgedAt: null,
      targets: [
        // Сообщение ушло на 20 секунд позже опроса: срок опроса всё равно решает.
        { id: 'a', userId: 'u1', status: 'sent', sentAt: new Date(SENT.getTime() + 20000), text: 'x', answeredAt: null, _count: { messages: 0 } },
        { id: 'b', userId: 'u2', status: 'sent', sentAt: SENT, text: 'x', answeredAt: null, _count: { messages: 1 } },
      ],
    }
    patch(t, prisma.botRound, 'updateMany', async () => ({ count: 0 }))
    patch(t, prisma.botRound, 'findMany', async () => [round])
    await tickRounds(new Date(SENT.getTime() + 10 * 60000 + 1000))
    await new Promise((r) => setTimeout(r, 20))
    assert.deepEqual(created.map((c) => c.userId), ['u1'])
  })
})
