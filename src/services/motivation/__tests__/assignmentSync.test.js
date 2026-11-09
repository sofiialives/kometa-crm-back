import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { desiredProfileId } from '../assignmentSync.js'

function linkedOf(rows) {
  return new Map(rows.map((p) => [`${p.departmentId}:${p.audience}`, p]))
}

describe('профиль по отделу и роли', () => {
  const linked = linkedOf([
    { id: 'design-staff', departmentId: 'design', audience: 'staff' },
    { id: 'design-lead', departmentId: 'design', audience: 'lead' },
    { id: 'seo-staff', departmentId: 'seo', audience: 'staff' },
  ])

  test('специалисту — профиль специалистов его отдела', () => {
    assert.equal(desiredProfileId({ role: 'staff', departmentId: 'design' }, linked, null), 'design-staff')
  })
  test('руководителю — свой профиль', () => {
    assert.equal(desiredProfileId({ role: 'lead', departmentId: 'design' }, linked, null), 'design-lead')
  })
  test('руководителю без своего профиля — условия специалистов отдела', () => {
    assert.equal(desiredProfileId({ role: 'lead', departmentId: 'seo' }, linked, null), 'seo-staff')
  })
  test('старый ручной профиль без отдела заменяется профилем отдела', () => {
    const current = { profileId: 'manual', profile: { archivedAt: null, departmentId: null } }
    assert.equal(desiredProfileId({ role: 'staff', departmentId: 'design' }, linked, current), 'design-staff')
  })
  test('отдел без профилей: ручной профиль закрывается', () => {
    const current = { profileId: 'manual', profile: { archivedAt: null } }
    assert.equal(desiredProfileId({ role: 'staff', departmentId: 'ads' }, linked, current), null)
  })
  test('нет отдела: ручной профиль закрывается', () => {
    assert.equal(desiredProfileId({ role: 'staff', departmentId: null }, linked, { profileId: 'manual' }), null)
  })
  test('нечего менять: уже без условий или нет назначения', () => {
    assert.equal(desiredProfileId({ role: 'staff', departmentId: 'ads' }, linked, { profileId: null }), undefined)
    assert.equal(desiredProfileId({ role: 'staff', departmentId: 'ads' }, linked, null), undefined)
    assert.equal(desiredProfileId({ role: 'staff', departmentId: null }, linked, null), undefined)
  })
  test('условия только руководителя: специалист без условий, руководитель с профилем', () => {
    const onlyLead = linkedOf([{ id: 'x-lead', departmentId: 'x', audience: 'lead' }])
    assert.equal(desiredProfileId({ role: 'staff', departmentId: 'x' }, onlyLead, { profileId: 'manual' }), null)
    assert.equal(desiredProfileId({ role: 'lead', departmentId: 'x' }, onlyLead, null), 'x-lead')
  })
  test('перевели в отдел без профилей: условия прежнего отдела снимаются', () => {
    const current = { profileId: 'design-staff', profile: { archivedAt: null, departmentId: 'design' } }
    assert.equal(desiredProfileId({ role: 'staff', departmentId: 'ads' }, linked, current), null)
  })
})

describe('история баллов: пометки и догрузка', async () => {
  const { sourceOf, encodeCursor, decodeCursor } = await import('../history.service.js')
  test('откуда запись', () => {
    assert.equal(sourceOf({ mode: 'auto', createdById: null, review: null }), 'auto')
    assert.equal(sourceOf({ mode: 'manual', createdById: 'u1', review: null }), 'manual')
    assert.equal(sourceOf({ mode: 'manual', createdById: 'u1', review: { id: 'r1' } }), 'review')
  })
  test('курсор держит и время, и id: одинаковое время ночных штрафов не теряет записи', () => {
    const at = '2026-10-16T20:59:00.000Z'
    const c = decodeCursor(encodeCursor({ at, id: 'cmabc' }))
    assert.equal(c.at.toISOString(), at)
    assert.equal(c.id, 'cmabc')
    assert.throws(() => decodeCursor('мусор'))
  })
})

describe('персональный профиль в назначении', () => {
  const linked = linkedOf([
    { id: 'design-staff', departmentId: 'design', audience: 'staff' },
    { id: 'design-lead', departmentId: 'design', audience: 'lead' },
  ])
  const personal = new Map([['u1', { id: 'personal-u1', userId: 'u1' }]])

  test('персональный профиль главнее профиля отдела и роли', () => {
    assert.equal(desiredProfileId({ id: 'u1', role: 'staff', departmentId: 'design' }, linked, null, personal), 'personal-u1')
    assert.equal(desiredProfileId({ id: 'u1', role: 'lead', departmentId: 'design' }, linked, { profileId: 'design-lead' }, personal), 'personal-u1')
  })
  test('персональный профиль работает и без отдела', () => {
    assert.equal(desiredProfileId({ id: 'u1', role: 'staff', departmentId: null }, linked, null, personal), 'personal-u1')
  })
  test('у других людей персональный профиль не действует', () => {
    assert.equal(desiredProfileId({ id: 'u2', role: 'staff', departmentId: 'design' }, linked, null, personal), 'design-staff')
  })
  test('без персонального профиля человек возвращается к отдельским условиям', () => {
    const current = { profileId: 'personal-u1' }
    assert.equal(desiredProfileId({ id: 'u1', role: 'staff', departmentId: 'design' }, linked, current, new Map()), 'design-staff')
    assert.equal(desiredProfileId({ id: 'u1', role: 'lead', departmentId: 'design' }, linkedOf([{ id: 'design-staff', departmentId: 'design', audience: 'staff' }]), current, new Map()), 'design-staff')
  })
})
