import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { departmentsWithoutProfile, withPosition } from '../teamView.js'

const row = (id, { position, department = null, profile = null } = {}) => ({
  employee: { id, name: id, position, department },
  profile,
  bankCents: 0,
})

describe('должность в таблице команды', () => {
  test('берётся из User.position, профиль мотивации остаётся отдельным полем', () => {
    const profile = { id: 'p1', title: 'Профиль отдела' }
    const [r] = withPosition([row('u1', { profile })], new Map([['u1', 'SEO-специалист']]))
    assert.equal(r.position, 'SEO-специалист')
    assert.equal(r.employee.position, 'SEO-специалист')
    assert.deepEqual(r.profile, profile)
  })

  test('у человека без профиля должность всё равно есть', () => {
    const [r] = withPosition([row('u1')], new Map([['u1', 'Таргетолог']]))
    assert.equal(r.position, 'Таргетолог')
    assert.equal(r.profile, null)
  })

  test('должность не задана — null, а не undefined', () => {
    const [r] = withPosition([row('u1')], new Map([['u1', null]]))
    assert.equal(r.position, null)
  })

  test('закрытый месяц: нынешняя должность важнее снимка, а без человека остаётся снимок', () => {
    const rows = withPosition(
      [row('u1', { position: 'Старая' }), row('u2', { position: 'Из снимка' })],
      new Map([['u1', 'Новая']]),
    )
    assert.equal(rows[0].position, 'Новая')
    assert.equal(rows[1].position, 'Из снимка')
  })
})

describe('отделы без условий баллов', () => {
  const seo = { id: 'd1', name: 'SEO' }
  const smm = { id: 'd2', name: 'SMM' }

  test('отдел без профиля попадает в список', () => {
    assert.deepEqual(departmentsWithoutProfile([seo, smm], [{ departmentId: 'd1' }], []), [smm])
  })

  test('у всех отделов есть профили — список пуст', () => {
    assert.deepEqual(departmentsWithoutProfile([seo], [{ departmentId: 'd1' }], []), [])
  })

  test('старый профиль без отдела, назначенный людям вручную, отдел покрывает', () => {
    const rows = [row('u1', { department: smm, profile: { id: 'p9' } })]
    assert.deepEqual(departmentsWithoutProfile([seo, smm], [{ departmentId: null }], rows), [seo])
  })

  test('человек без профиля отдел не покрывает', () => {
    const rows = [row('u1', { department: smm })]
    assert.deepEqual(departmentsWithoutProfile([smm], [], rows), [smm])
  })
})
