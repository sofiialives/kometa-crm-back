import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { toldOwnerReply } from '../ai/agent.js'

describe('ответ человеку после tell_owner', () => {
  test('передал Яну, а агент промолчал, человек всё равно слышит ответ', () => {
    assert.equal(toldOwnerReply({ tools: ['tell_owner'], toldOwner: true }), 'Понял, передал Яну')
  })

  test('заметка не ушла, ночь или лимит, человеку честно «записал»', () => {
    assert.match(toldOwnerReply({ tools: ['tell_owner'], toldOwner: false }), /^Записал/)
  })

  test('tell_owner не вызывали, правило молчит', () => {
    assert.equal(toldOwnerReply({ tools: ['get_person'] }), null)
    assert.equal(toldOwnerReply({}), null)
  })

  test('отлучка уже ответила стандартной фразой, второй ответ не нужен', () => {
    assert.equal(toldOwnerReply({ tools: ['tell_owner', 'set_away'], toldOwner: true }), null)
  })

  test('бот уже показал кнопку, лишнего не пишем', () => {
    assert.equal(toldOwnerReply({ tools: ['tell_owner'], toldOwner: true, quiet: true }), null)
  })
})
