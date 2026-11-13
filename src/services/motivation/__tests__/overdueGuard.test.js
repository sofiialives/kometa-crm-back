import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { prisma } from '../../../config/prisma.js'
import { chargeNight } from '../autoTasks.service.js'

const task = { id: 't1', ownerId: 'u1', title: 'Отчет по кампании', deadline: new Date('2026-11-11T21:00:00Z'), origin: 'hierarchy' }
const night = { at: new Date('2026-11-12T20:59:59Z'), dayKey: '2026-11-12' }
const found = { type: { id: 'et', title: 'Просрочена задача из Иерархии', prizePoints: -10, levelPoints: -10 }, profile: { id: 'p1' } }
const settings = { overduePenaltyCap: 30 }

/** Транзакция на подменённом tx: что уже есть в журнале и в заявках. */
function run(t, { earlier = null, review = null } = {}) {
  const created = []
  const tx = {
    $executeRaw: async () => 0,
    motivationEvent: {
      findUnique: async () => null,
      findFirst: async () => earlier,
      aggregate: async () => ({ _sum: { prizePoints: 0, levelPoints: 0 } }),
      create: async ({ data }) => { created.push(data); return data },
    },
    motivationReview: { findFirst: async () => review },
  }
  const original = prisma.$transaction
  prisma.$transaction = (fn) => fn(tx)
  t.after(() => { prisma.$transaction = original })
  return { created, go: () => chargeNight(task, 'task_overdue', night, found, settings) }
}

describe('просрочка не снимается второй раз', () => {
  test('штраф по задаче уже был под старым ключом по ночи: не снимаем', async (t) => {
    const { created, go } = run(t, { earlier: { id: 'old' } })
    assert.equal(await go(), 'exists')
    assert.equal(created.length, 0)
  })

  test('Ян уже решал по этой задаче, например «Не снимать»: не снимаем', async (t) => {
    const { created, go } = run(t, { review: { id: 'r1' } })
    assert.equal(await go(), 'capped')
    assert.equal(created.length, 0)
  })

  test('ни штрафа, ни решения не было: снимаем один раз', async (t) => {
    const { created, go } = run(t)
    assert.equal(await go(), 'created')
    assert.equal(created.length, 1)
    assert.equal(created[0].prizePoints, -10)
  })
})
