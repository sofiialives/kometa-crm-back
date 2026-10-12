import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  assertAdmin, assertCanManage, assertCanView, assertParticipant, assertViewer, canManage, canView, isParticipant, isViewer,
} from '../access.js'
import { departmentScope } from '../team.service.js'
import { isDuplicate, requestKeyFor } from '../dedupe.js'

// Модель доступа вкладки, как её решил заказчик:
// - банк и баллы есть у сотрудников и руководителей, нет только у владельца;
// - менять деньги и баллы может только владелец — всем, у кого есть банк;
// - руководитель видит сотрудников своего отдела и себя, но ничего не меняет.

const owner = { id: 'a', role: 'admin', departmentId: null }
const leadDesign = { id: 'l1', role: 'lead', departmentId: 'design' }
const leadDesign2 = { id: 'l3', role: 'lead', departmentId: 'design' }
const leadNoDept = { id: 'l0', role: 'lead', departmentId: null }
const leadDev = { id: 'l2', role: 'lead', departmentId: 'dev' }
const nick = { id: 's1', role: 'staff', departmentId: 'design' }
const roman = { id: 's2', role: 'staff', departmentId: 'design' }
const igor = { id: 's3', role: 'staff', departmentId: 'dev' }

const forbids = (fn, status = 403) => assert.throws(fn, (e) => e.status === status)

describe('у кого есть банк', () => {
  test('у сотрудника и руководителя есть, у владельца нет', () => {
    assert.equal(isParticipant(nick), true)
    assert.equal(isParticipant(leadDesign), true)
    assert.equal(isParticipant(owner), false)
    assert.doesNotThrow(() => assertParticipant(nick))
    assert.doesNotThrow(() => assertParticipant(leadDesign))
    forbids(() => assertParticipant(owner))
  })

  test('«Команду» смотрят руководитель и владелец', () => {
    assert.equal(isViewer(owner), true)
    assert.equal(isViewer(leadDesign), true)
    assert.equal(isViewer(nick), false)
    forbids(() => assertViewer(nick))
  })

  test('настройки и начисления — только владелец', () => {
    assert.doesNotThrow(() => assertAdmin(owner))
    forbids(() => assertAdmin(leadDesign))
    forbids(() => assertAdmin(nick))
  })
})

describe('кто управляет деньгами и баллами', () => {
  test('владелец — и сотрудниками, и руководителями', () => {
    assert.equal(canManage(owner, nick), true)
    assert.equal(canManage(owner, igor), true)
    assert.equal(canManage(owner, leadDesign), true)
  })

  test('себе владелец ничего не начисляет: у него нет банка', () => {
    assert.equal(canManage(owner, owner), false)
  })

  test('руководитель не начисляет даже своему отделу и себе', () => {
    assert.equal(canManage(leadDesign, nick), false)
    assert.equal(canManage(leadDesign, leadDesign), false)
    forbids(() => assertCanManage(leadDesign, nick))
  })

  test('сотрудник не управляет никем', () => {
    assert.equal(canManage(nick, roman), false)
    assert.equal(canManage(nick, nick), false)
  })
})

describe('кто кого видит', () => {
  test('каждый видит себя — и сотрудник, и руководитель', () => {
    assert.doesNotThrow(() => assertCanView(nick, nick))
    assert.doesNotThrow(() => assertCanView(leadDesign, leadDesign))
  })

  test('сотрудник не видит коллегу — ответ как на несуществующего', () => {
    forbids(() => assertCanView(nick, roman), 404)
  })

  test('руководитель видит сотрудников своего отдела', () => {
    assert.equal(canView(leadDesign, nick), true)
    assert.equal(canView(leadDesign, roman), true)
  })

  test('руководитель не видит чужой отдел и других руководителей', () => {
    forbids(() => assertCanView(leadDesign, igor), 404)
    assert.equal(canView(leadDesign, leadDev), false)
    assert.equal(canView(leadDesign, leadDesign2), false)
  })

  test('руководитель без отдела видит только себя', () => {
    assert.equal(canView(leadNoDept, { ...nick, departmentId: null }), false)
    assert.equal(canView(leadNoDept, leadNoDept), true)
  })

  test('владелец видит всех, у кого есть банк', () => {
    assert.equal(canView(owner, igor), true)
    assert.equal(canView(owner, leadDev), true)
    assert.equal(canView(owner, owner), false)
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

  test('владелец без фильтра видит всех, с фильтром — выбранный отдел', () => {
    assert.equal(departmentScope(owner, undefined), null)
    assert.equal(departmentScope(owner, 'dev'), 'dev')
  })
})

describe('защита от повторной отправки', () => {
  test('ключ свой у каждого человека в одном запросе', () => {
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
