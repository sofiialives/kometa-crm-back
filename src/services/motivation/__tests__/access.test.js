import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  assertAdmin, assertCanCancelInMonth, assertCanView, assertEmployee, assertManager, canManage, isEmployee, isManager,
} from '../access.js'
import { departmentScope } from '../team.service.js'
import { isDuplicate, requestKeyFor } from '../dedupe.js'

// Модель доступа вкладки: сотрудник видит себя, руководитель управляет своим
// отделом, админ — всеми. Банк и баллы есть только у сотрудников.

const admin = { id: 'a', role: 'admin', departmentId: null }
const leadDesign = { id: 'l1', role: 'lead', departmentId: 'design' }
const leadNoDept = { id: 'l0', role: 'lead', departmentId: null }
const nick = { id: 's1', role: 'staff', departmentId: 'design' }
const roman = { id: 's2', role: 'staff', departmentId: 'design' }
const igor = { id: 's3', role: 'staff', departmentId: 'dev' }
const leadDev = { id: 'l2', role: 'lead', departmentId: 'dev' }

const forbids = (fn, status = 403) => assert.throws(fn, (e) => e.status === status)

describe('роли', () => {
  test('банк и баллы — только у сотрудников', () => {
    assert.equal(isEmployee(nick), true)
    assert.equal(isEmployee(leadDesign), false)
    assert.equal(isEmployee(admin), false)
    assert.doesNotThrow(() => assertEmployee(nick))
    forbids(() => assertEmployee(leadDesign))
    forbids(() => assertEmployee(admin))
  })

  test('руководитель и админ — управляющие, сотрудник нет', () => {
    assert.equal(isManager(admin), true)
    assert.equal(isManager(leadDesign), true)
    assert.equal(isManager(nick), false)
    forbids(() => assertManager(nick))
  })

  test('настройки — только админ', () => {
    assert.doesNotThrow(() => assertAdmin(admin))
    forbids(() => assertAdmin(leadDesign))
    forbids(() => assertAdmin(nick))
  })
})

describe('кем можно управлять', () => {
  test('админ управляет любым сотрудником', () => {
    assert.equal(canManage(admin, nick), true)
    assert.equal(canManage(admin, igor), true)
  })

  test('руководитель — только своим отделом', () => {
    assert.equal(canManage(leadDesign, nick), true)
    assert.equal(canManage(leadDesign, igor), false)
    assert.equal(canManage(leadDev, igor), true)
  })

  test('руководитель без отдела не управляет никем', () => {
    assert.equal(canManage(leadNoDept, { ...nick, departmentId: null }), false)
  })

  test('руководителем и админом управлять нельзя: у них нет банка', () => {
    assert.equal(canManage(admin, leadDesign), false)
    assert.equal(canManage(leadDesign, { ...leadDev, departmentId: 'design' }), false)
  })

  test('сотрудник не управляет даже коллегой из своего отдела', () => {
    assert.equal(canManage(nick, roman), false)
  })
})

describe('кто кого видит', () => {
  test('сотрудник видит себя', () => {
    assert.doesNotThrow(() => assertCanView(nick, nick))
  })

  test('сотрудник не видит коллегу — ответ как на несуществующего', () => {
    forbids(() => assertCanView(nick, roman), 404)
  })

  test('руководитель видит своих и не видит чужой отдел', () => {
    assert.doesNotThrow(() => assertCanView(leadDesign, nick))
    forbids(() => assertCanView(leadDesign, igor), 404)
  })

  test('админ видит всех сотрудников', () => {
    assert.doesNotThrow(() => assertCanView(admin, igor))
  })
})

describe('таблица команды', () => {
  test('руководитель всегда смотрит свой отдел', () => {
    assert.equal(departmentScope(leadDesign, undefined), 'design')
    assert.equal(departmentScope(leadDesign, 'design'), 'design')
  })

  test('подставить чужой отдел руководитель не может', () => {
    forbids(() => departmentScope(leadDesign, 'dev'))
  })

  test('руководитель без отдела получает понятный отказ', () => {
    forbids(() => departmentScope(leadNoDept, undefined))
  })

  test('админ без фильтра видит всех, с фильтром — выбранный отдел', () => {
    assert.equal(departmentScope(admin, undefined), null)
    assert.equal(departmentScope(admin, 'dev'), 'dev')
  })
})

describe('отмена событий по месяцам', () => {
  test('руководитель отменяет события текущего месяца', () => {
    assert.doesNotThrow(() => assertCanCancelInMonth(leadDesign, '2026-11', '2026-11'))
  })

  test('прошлый месяц руководитель не трогает', () => {
    forbids(() => assertCanCancelInMonth(leadDesign, '2026-10', '2026-11'))
  })

  test('админ может отменить и в прошлом месяце', () => {
    assert.doesNotThrow(() => assertCanCancelInMonth(admin, '2026-10', '2026-11'))
  })
})

describe('защита от повторной отправки', () => {
  test('ключ свой у каждого сотрудника в одном запросе', () => {
    assert.equal(requestKeyFor('k1', 's1'), 'request:k1:s1')
    assert.notEqual(requestKeyFor('k1', 's1'), requestKeyFor('k1', 's2'))
  })

  test('без ключа защиты нет, запись проходит как раньше', () => {
    assert.equal(requestKeyFor(undefined, 's1'), null)
    assert.equal(isDuplicate({ code: 'P2002' }, undefined), false)
  })

  test('повтором считается только нарушение уникальности при ключе', () => {
    assert.equal(isDuplicate({ code: 'P2002' }, 'k1'), true)
    assert.equal(isDuplicate({ code: 'P2025' }, 'k1'), false)
  })
})
