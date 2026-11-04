import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { prisma } from '../../config/prisma.js'
import { speaker } from '../ai/context.js'
import { roundStatus } from '../agent/rounds.js'
import { patch } from './patch.js'

const at = (iso) => new Date(iso)
const owner = { id: 'owner', role: 'admin' }
const person = { id: 'r', name: 'Роман Котов', role: 'staff', departmentId: 'd', department: { name: 'Дизайн' } }
const round = { id: 'rd1', topic: 'Как дела', status: 'sent', sentAt: at('2026-11-04T10:00:00Z'), deadlineAt: at('2026-11-04T12:00:00Z') }

describe('агент владельца видит и то, что бот писал человеку', () => {
  test('кто сказал: человек, агент или бот по поручению', () => {
    assert.equal(speaker({ direction: 'in' }), 'человек написал')
    assert.equal(speaker({ direction: 'reply' }), 'человек написал')
    assert.equal(speaker({ direction: 'out', source: 'ai' }), 'агент ответил')
    assert.equal(speaker({ direction: 'out', source: 'round' }), 'бот написал по поручению')
  })

  test('get_round: переписка по порядку, сообщения бота с временем, шаблоны не попадают', async (t) => {
    patch(t, prisma.botRound, 'findFirst', async () => round)
    patch(t, prisma.botRoundTarget, 'findMany', async () => [{
      userId: 'r', user: person, status: 'answered', summary: 'Баннер почти готов',
      messages: [
        { direction: 'out', source: 'round', text: 'Ян попросил узнать, как баннер', createdAt: at('2026-11-04T10:00:00Z') },
        { direction: 'in', source: null, text: 'Делаю, почти готово', createdAt: at('2026-11-04T10:05:00Z') },
        { direction: 'out', source: 'ai', text: 'Скинь скрин', createdAt: at('2026-11-04T10:05:30Z') },
        { direction: 'out', source: null, text: 'Шаблон бота', createdAt: at('2026-11-04T10:06:00Z') },
      ],
    }])
    const text = await roundStatus(owner)
    const talk = text.split('\n').filter((l) => /^ {2}\d\d:\d\d/.test(l))
    assert.deepEqual(talk, [
      '  13:00 бот написал по поручению «Ян попросил узнать, как баннер»',
      '  13:05 человек написал «Делаю, почти готово»',
      '  13:05 агент ответил «Скинь скрин»',
    ])
    assert.doesNotMatch(text, /Шаблон бота/)
  })

  test('длинная переписка обрезается с пометкой, сколько раньше', async (t) => {
    patch(t, prisma.botRound, 'findFirst', async () => round)
    const messages = Array.from({ length: 15 }, (_, i) => ({ direction: 'in', source: null, text: `слово ${i}`, createdAt: at(`2026-11-04T10:${String(i).padStart(2, '0')}:00Z`) }))
    patch(t, prisma.botRoundTarget, 'findMany', async () => [{ userId: 'r', user: person, status: 'sent', summary: null, messages }])
    const text = await roundStatus(owner)
    assert.match(text, /раньше ещё сообщений 3\n/)
    assert.doesNotMatch(text, /слово 2»/)
    assert.match(text, /слово 14»/)
  })
})
