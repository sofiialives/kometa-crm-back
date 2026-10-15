import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { desiredProfileId } from '../assignmentSync.js'

function linkedOf(rows) {
  const map = new Map(rows.map((p) => [`${p.departmentId}:${p.audience}`, p]))
  map.departments = new Set(rows.map((p) => p.departmentId))
  return map
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
  test('отдел на старых ручных профилях — назначение не трогаем', () => {
    const current = { profileId: 'manual', profile: { archivedAt: null } }
    assert.equal(desiredProfileId({ role: 'staff', departmentId: 'ads' }, linked, current), undefined)
  })
  test('удалённый ручной профиль снимается', () => {
    const current = { profileId: 'old', profile: { archivedAt: new Date() } }
    assert.equal(desiredProfileId({ role: 'staff', departmentId: 'ads' }, linked, current), null)
  })
  test('у отдела есть только профиль руководителя — у специалиста условий нет', () => {
    const onlyLead = linkedOf([{ id: 'x-lead', departmentId: 'x', audience: 'lead' }])
    assert.equal(desiredProfileId({ role: 'staff', departmentId: 'x' }, onlyLead, { profileId: 'manual', profile: { archivedAt: null } }), null)
  })
  test('перевели в отдел без профилей — условия прежнего отдела снимаются', () => {
    const current = { profileId: 'design-staff', profile: { archivedAt: null, departmentId: 'design' } }
    assert.equal(desiredProfileId({ role: 'staff', departmentId: 'ads' }, linked, current), null)
  })
})
