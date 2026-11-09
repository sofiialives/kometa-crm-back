import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { prisma } from '../../../config/prisma.js'
import { withdrawPending } from '../review.service.js'
import { getBotJournalTeam } from '../botJournal.service.js'
import { sumSummaries, summarize } from '../botJournalRules.js'
import { withdrawReviewsSchema, botJournalSchema } from '../../../schemas/motivation.schema.js'

const admin = { id: 'a1', role: 'admin', name: 'Ян' }
const id = (n) => `c${String(n).padStart(24, '0')}`

// Фальшивая база в памяти: ровно те вызовы, что делают сервисы.
function fakeDb(reviews) {
  const matches = (r, where) =>
    (!where.status || r.status === where.status) &&
    (!where.id || where.id.in.includes(r.id)) &&
    (!where.userId || where.userId.in.includes(r.userId))
  prisma.$transaction = async (fn) => fn(prisma)
  prisma.$executeRaw = async () => 0
  prisma.motivationReview = {
    findMany: async ({ where }) => reviews.filter((r) => matches(r, where)).map((r) => ({ ...r })),
    updateMany: async ({ where, data }) => {
      const hit = reviews.filter((r) => matches(r, where))
      hit.forEach((r) => Object.assign(r, data))
      return { count: hit.length }
    },
    count: async ({ where }) => reviews.filter((r) => matches(r, where)).length,
  }
}

describe('массовое снятие заявок', () => {
  let reviews
  beforeEach(() => {
    reviews = [
      { id: 'r1', userId: 'u1', status: 'pending' },
      { id: 'r2', userId: 'u1', status: 'pending' },
      { id: 'r3', userId: 'u2', status: 'pending' },
      { id: 'r4', userId: 'u2', status: 'approved' },
    ]
    fakeDb(reviews)
  })

  test('по списку id: снимает только ждущие, пишет кто снял', async () => {
    const res = await withdrawPending(admin, { ids: ['r1', 'r4'] })
    assert.equal(res.withdrawn, 1)
    assert.equal(res.pending, 2)
    assert.equal(reviews[0].status, 'rejected')
    assert.equal(reviews[0].decidedById, 'a1')
    assert.equal(reviews[0].decisionNote, 'Снял Ян')
    assert.ok(reviews[0].decidedAt)
    assert.equal(reviews[3].status, 'approved')
  })
  test('по людям', async () => {
    assert.equal((await withdrawPending(admin, { userIds: ['u1'] })).withdrawn, 2)
    assert.equal(reviews[2].status, 'pending')
  })
  test('все сразу', async () => {
    const res = await withdrawPending(admin, { all: true })
    assert.equal(res.withdrawn, 3)
    assert.equal(res.pending, 0)
  })
  test('повторный вызов ничего не снимает второй раз', async () => {
    await withdrawPending(admin, { all: true })
    const before = reviews.map((r) => ({ ...r }))
    assert.equal((await withdrawPending(admin, { all: true })).withdrawn, 0)
    assert.deepEqual(reviews, before)
  })
  test('не владельцу нельзя', async () => {
    await assert.rejects(withdrawPending({ id: 'l1', role: 'lead' }, { all: true }), { status: 403 })
    assert.ok(reviews.every((r) => r.status !== 'rejected'))
  })
  test('нужен ровно один способ выбора', async () => {
    await assert.rejects(withdrawPending(admin, {}), { status: 400 })
    await assert.rejects(withdrawPending(admin, { ids: ['r1'], all: true }), { status: 400 })
  })
  test('схема запроса', () => {
    const ok = (body) => withdrawReviewsSchema.safeParse({ body }).success
    assert.ok(ok({ all: true }))
    assert.ok(ok({ ids: [id(1)] }))
    assert.ok(!ok({}))
    assert.ok(!ok({ all: true, userIds: [id(1)] }))
    assert.ok(!ok({ ids: [] }))
  })
})

describe('журнал бота: команда и отдел', () => {
  const lead = { id: 'l1', role: 'lead', departmentId: 'd1' }
  const person = (idv, dep, role = 'staff') => ({ id: idv, name: idv, email: `${idv}@x`, role, active: true, departmentId: dep, department: { id: dep, name: dep } })
  const MIN = 60000
  const t0 = new Date('2026-11-03T09:00:00Z')
  let asked

  beforeEach(() => {
    asked = {}
    const users = [person('s1', 'd1'), person('s2', 'd1'), person('s3', 'd2'), person('l1', 'd1', 'lead')]
    prisma.department.findUnique = async ({ where }) => (['d1', 'd2'].includes(where.id) ? { id: where.id, name: where.id } : null)
    prisma.user.findMany = async ({ where }) => {
      asked.dep = where.departmentId
      return users.filter((u) => !where.departmentId || u.departmentId === where.departmentId)
    }
    prisma.motivationAway.findMany = async () => [
      { id: 'b1', userId: 's1', kind: 'break', from: t0, until: new Date(t0.getTime() + 30 * MIN), returnedAt: new Date(t0.getTime() + 40 * MIN), endedAt: null, extensions: 0, source: 'bot', reason: 'обед' },
      { id: 'b2', userId: 's3', kind: 'break', from: t0, until: new Date(t0.getTime() + 30 * MIN), returnedAt: new Date(t0.getTime() + 30 * MIN), endedAt: null, extensions: 1, source: 'bot', reason: null },
      { id: 'f1', userId: 's2', kind: 'force_majeure', from: t0, until: new Date(t0.getTime() + 60 * MIN), endedAt: null, source: 'owner', createdBy: { name: 'Ян' }, reason: 'болен' },
    ]
    prisma.botCheckinAnswer.findMany = async () => [
      { id: 'c1', userId: 's1', status: 'answered', answer: 'ок', eventId: null, answeredAt: t0, checkin: { day: '2026-11-03', startedAt: t0 } },
    ]
    prisma.botEvent.findMany = async () => [{ id: 'e1', userId: 's1', type: 'late', at: t0, text: 'задерживаюсь', data: null }]
    prisma.motivationReview.findMany = async () => []
    prisma.motivationEvent.findMany = async () => []
    prisma.telegramLink.findMany = async () => [{ userId: 's1', chatId: '1' }]
  })

  const now = new Date('2026-11-09T10:00:00Z')

  test('владелец, вся команда: счётчики по людям и итог', async () => {
    const r = await getBotJournalTeam(admin, { scope: 'all', month: '2026-11' }, now)
    assert.equal(r.scope, 'all')
    assert.equal(r.people.length, 4)
    const s1 = r.people.find((p) => p.employee.id === 's1')
    assert.equal(s1.summary.breaks, 1)
    assert.equal(s1.summary.lateBreaks, 1)
    assert.equal(s1.summary.lateReports, 1)
    assert.equal(s1.summary.checkins.answered, 1)
    assert.equal(s1.telegram, true)
    assert.equal(r.people.find((p) => p.employee.id === 's2').summary.forceMajeure, 1)
    assert.equal(r.totals.breaks, 2)
    assert.equal(r.totals.forceMajeure, 1)
    assert.equal(r.totals.extensions, 1)
    assert.equal(r.totals.checkins.answered, 1)
    assert.equal(r.full, true)
  })
  test('владелец, отдел: только люди отдела', async () => {
    const r = await getBotJournalTeam(admin, { departmentId: 'd2', month: '2026-11' }, now)
    assert.equal(r.scope, 'department')
    assert.deepEqual(r.people.map((p) => p.employee.id), ['s3'])
    assert.equal(r.department.id, 'd2')
    assert.equal(r.totals.breaks, 1)
  })
  test('руководитель: scope=all даёт только его отдел', async () => {
    const r = await getBotJournalTeam(lead, { scope: 'all', month: '2026-11' }, now)
    assert.ok(r.people.every((p) => p.employee.departmentId === 'd1' || p.employee.department?.id === 'd1'))
    assert.ok(!r.people.some((p) => p.employee.id === 's3'))
    assert.equal(r.full, false)
  })
  test('руководитель: чужой отдел и неизвестный отдел — 404', async () => {
    await assert.rejects(getBotJournalTeam(lead, { departmentId: 'd2' }, now), { status: 404 })
    await assert.rejects(getBotJournalTeam(admin, { departmentId: 'nope' }, now), { status: 404 })
  })
  test('сотруднику нельзя', async () => {
    await assert.rejects(getBotJournalTeam({ id: 's1', role: 'staff' }, { scope: 'all' }, now), { status: 403 })
  })
  test('сумма сводок', () => {
    const a = summarize([{ kind: 'force_majeure' }])
    const sum = sumSummaries([a, a])
    assert.equal(sum.forceMajeure, 2)
    assert.equal(sum.checkins.asked, 0)
  })
  test('схема: ровно один из userId, scope, departmentId', () => {
    const ok = (query) => botJournalSchema.safeParse({ query }).success
    assert.ok(ok({ userId: id(1) }))
    assert.ok(ok({ scope: 'all', month: '2026-11' }))
    assert.ok(ok({ departmentId: id(2) }))
    assert.ok(!ok({}))
    assert.ok(!ok({ scope: 'all', departmentId: id(2) }))
    assert.ok(!ok({ scope: 'x' }))
  })
})
