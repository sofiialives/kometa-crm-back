import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { prisma } from '../../../config/prisma.js'
import { createProfile, deleteProfile, getSettings } from '../settings.service.js'
import { assignmentAt } from '../profiles.js'
import { syncAssignments } from '../assignmentSync.js'

const admin = { id: 'admin-test', role: 'admin' }
const tag = `pt${Date.now()}`
let dep, user, lead

describe('персональный профиль (база)', { skip: !process.env.DATABASE_URL }, () => {
  before(async () => {
    dep = await prisma.department.create({ data: { name: `${tag} SEO` } })
    user = await prisma.user.create({ data: { name: `${tag} Иван`, email: `${tag}-a@test.local`, role: 'staff', departmentId: dep.id } })
    lead = await prisma.user.create({ data: { name: `${tag} Лид`, email: `${tag}-b@test.local`, role: 'lead', departmentId: dep.id } })
  })
  after(async () => {
    const ids = [user?.id, lead?.id].filter(Boolean)
    await prisma.motivationAssignment.deleteMany({ where: { userId: { in: ids } } })
    await prisma.motivationProfile.deleteMany({ where: { OR: [{ departmentId: dep?.id }, { userId: { in: ids } }, { title: { contains: tag } }] } })
    await prisma.user.deleteMany({ where: { id: { in: ids } } })
    if (dep) await prisma.department.delete({ where: { id: dep.id } })
    await prisma.$disconnect()
  })

  test('профиль отдела: название само, без copyFrom, назначается людям', async () => {
    const p = await createProfile(admin, { departmentId: dep.id, audience: 'staff' })
    assert.equal(p.title, `Отдел ${tag} SEO · Специалист`)
    assert.ok(p.events.length > 0)
    assert.equal((await assignmentAt(user.id)).profileId, p.id)
    // руководитель без своего профиля — условия специалистов
    assert.equal((await assignmentAt(lead.id)).profileId, p.id)
  })

  test('создание персонального копирует текущие условия и сразу назначается', async () => {
    const dept = await prisma.motivationProfile.findFirst({ where: { departmentId: dep.id, audience: 'staff' }, include: { eventTypes: true } })
    const p = await createProfile(admin, { userId: user.id, departmentId: dep.id, audience: 'staff' })
    assert.equal(p.title, `${tag} Иван · персонально`)
    assert.equal(p.userId, user.id)
    assert.equal(p.events.length, dept.eventTypes.length)
    assert.equal((await assignmentAt(user.id)).profileId, p.id)
    assert.equal((await assignmentAt(lead.id)).profileId, dept.id)
    await assert.rejects(createProfile(admin, { userId: user.id }), /уже есть/)
  })

  test('список для настроек: профили отдела и люди с personalProfileId', async () => {
    const s = await getSettings(admin)
    const d = s.departments.find((x) => x.id === dep.id)
    assert.ok(d.staffProfileId)
    assert.equal(d.leadProfileId, null)
    const person = d.people.find((x) => x.id === user.id)
    assert.deepEqual(Object.keys(person).sort(), ['avatarColor', 'avatarUrl', 'id', 'name', 'personalProfileId', 'position', 'role'])
    assert.ok(person.personalProfileId)
    assert.equal(d.people.find((x) => x.id === lead.id).personalProfileId, null)
  })

  test('только владелец', async () => {
    await assert.rejects(createProfile({ role: 'staff' }, { userId: user.id }))
  })

  test('удаление персонального возвращает отдельские условия, история остаётся', async () => {
    const personal = await prisma.motivationProfile.findFirst({ where: { userId: user.id } })
    const before = await prisma.motivationAssignment.count({ where: { userId: user.id } })
    await deleteProfile(admin, personal.id)
    const dept = await prisma.motivationProfile.findFirst({ where: { departmentId: dep.id, audience: 'staff' } })
    assert.equal((await assignmentAt(user.id)).profileId, dept.id)
    // старые назначения не переписаны, добавилось новое
    assert.equal(await prisma.motivationAssignment.count({ where: { userId: user.id } }), before + 1)
    // были назначения: профиль в архиве, человек освобождён
    const archived = await prisma.motivationProfile.findUnique({ where: { id: personal.id } })
    assert.ok(archived.archivedAt)
    assert.equal(archived.userId, null)
    // можно завести снова
    const again = await createProfile(admin, { userId: user.id })
    assert.equal(again.userId, user.id)
    assert.equal(await syncAssignments(), 0)
  })
})
