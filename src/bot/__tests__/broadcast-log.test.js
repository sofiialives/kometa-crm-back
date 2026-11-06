import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { prisma } from '../../config/prisma.js'
import { broadcast } from '../reminders.js'
import { botHarness } from './harness.js'
import { patch } from './patch.js'

describe('рассылка по расписанию попадает в журнал', () => {
  test('каждое сообщение ложится в BotMessage, форс-мажор пропускаем', async (t) => {
    const h = botHarness(t)
    patch(t, prisma.telegramLink, 'findMany', async () => [{ chatId: '1', userId: 'u1' }, { chatId: '2', userId: 'u2' }])
    patch(t, prisma.motivationAway, 'findMany', async () => [{ userId: 'u2' }])
    await broadcast('Доброе утро\nРасставь задачи на сегодня до 10:00')
    assert.equal(h.sent.length, 1)
    assert.deepEqual(h.logged.map((m) => [m.userId, m.chatId, m.direction, m.text]), [['u1', '1', 'out', 'Доброе утро\nРасставь задачи на сегодня до 10:00']])
  })
})
