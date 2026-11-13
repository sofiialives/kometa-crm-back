import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { prisma } from '../../config/prisma.js'
import { ownerAutoText } from '../agent/feed.js'
import { confirmText, directNote, forwardReply, isNamedIn, liveCloseText, namesakeIn, nameVariants, sentNote, toCyrillic } from '../agent/rounds.js'
import { botHarness } from './harness.js'
import { patch } from './patch.js'

const person = { id: 'v', name: 'Vladislav', role: 'staff', active: true, departmentId: 'd', department: { name: 'Хочу Плачу' } }
const at = (iso) => new Date(iso)

describe('имена латиницей и коротко', () => {
  test('Vladislav это Владислав и Влад, Alex это Алекс', () => {
    assert.equal(toCyrillic('Vladislav'), 'владислав')
    assert.equal(toCyrillic('Alex'), 'алекс')
    assert.equal(toCyrillic('Nikolai'), 'николай')
    assert.equal(toCyrillic('Sergei'), 'сергей')
    assert.ok(nameVariants('Vladislav').includes('влад'))
    const ask = ['Узнай у Влада и Алекса из Хочу Плачу, начали ли они уже']
    assert.equal(isNamedIn({ name: 'Vladislav' }, ask), true)
    assert.equal(isNamedIn({ name: 'Alex' }, ask), true)
  })

  test('не цепляет лишнего: Alexandr не Алекс, Коля это Николай, «надо» не Надя', () => {
    assert.equal(isNamedIn({ name: 'Alexandr' }, ['Узнай у Алекса']), false)
    assert.equal(isNamedIn({ name: 'Николай Волков' }, ['напиши Коле']), true)
    assert.equal(isNamedIn({ name: 'Nadya' }, ['надо сделать']), false)
    assert.equal(isNamedIn({ name: 'Анна Тестова' }, ['Узнай у Ани']), true)
    assert.equal(isNamedIn({ name: 'Анна Тестова' }, ['кани и ани']), false)
    assert.equal(isNamedIn({ name: 'Ян' }, ['напиши Яну']), false)
    // Короткие имена, совпадающие с обычными словами, не считаются.
    assert.equal(isNamedIn({ name: 'Артём Ким' }, ['Тема такая, узнай, как дела']), false)
    assert.equal(isNamedIn({ name: 'Вячеслав' }, ['Слава богу, всё готово']), false)
    // Короткая основа только с большой буквы: «влад» в середине слова не имя.
    assert.equal(isNamedIn({ name: 'Vladislav' }, ['владелец просил']), false)
  })
})

describe('ответы на опрос сразу', () => {
  const yan = { id: 'yan', name: 'Ян', role: 'admin', active: true, departmentId: null, department: null }
  function world(t, { live = true, kind = 'ask', status = 'sent', messages, owner = yan } = {}) {
    const h = botHarness(t)
    patch(t, prisma.telegramLink, 'findFirst', async () => ({ chatId: 'chat-yan' }))
    patch(t, prisma.botRoundTarget, 'findUnique', async () => ({ id: 't1', userId: 'v', user: person, round: { ownerId: owner.id, owner, kind, live, status } }))
    patch(t, prisma.botMessage, 'findMany', async () => messages ?? [{ id: 'm1', direction: 'in', text: 'Начал, собираю базу', createdAt: at('2026-11-10T08:52:00Z') }])
    return h
  }

  test('человек ответил: Яну сразу его слова и время', async (t) => {
    const h = world(t)
    assert.equal(await forwardReply('t1', ['m1']), true)
    const sent = h.sent.filter((m) => m.chatId === 'chat-yan')
    assert.equal(sent.length, 1)
    assert.match(sent[0].text, /<b>Vladislav, хочу Плачу<\/b>, 11:52\nНачал, собираю базу/)
  })

  test('то же сообщение второй раз не пересылается', async (t) => {
    const h = world(t)
    await forwardReply('t1', ['m1'])
    await forwardReply('t1', ['m1'])
    assert.equal(h.sent.filter((m) => m.chatId === 'chat-yan').length, 1)
  })

  test('опрос с названным временем, утренний обход, закрытый опрос: не пересылаем', async (t) => {
    const otherLead = { id: 'l2', name: 'Нина', role: 'lead', active: true, departmentId: 'd2', department: { name: 'SEO' } }
    for (const opts of [{ live: false }, { kind: 'morning' }, { status: 'closed' }, { owner: { ...yan, active: false } }, { owner: otherLead }]) {
      await t.test(JSON.stringify(opts), async (tt) => {
        const h = world(tt, opts)
        assert.equal(await forwardReply('t1', ['m1']), false)
        assert.equal(h.sent.length, 0)
      })
    }
  })

  test('в срок только кто промолчал; ответили все — ничего', () => {
    const round = { topic: 'Начали ли работу' }
    assert.equal(liveCloseText({ round, answered: [{ label: 'Vladislav' }], silent: [], failed: [] }), null)
    const text = liveCloseText({ round, answered: [{ label: 'Vladislav' }], silent: [{ label: 'Alex' }], failed: [] })
    assert.match(text, /Ответили 1 из 2\n<b>Не ответили<\/b> Alex/)
  })

  test('Яну сразу видно, как придут ответы', () => {
    const at = new Date('2026-11-10T09:48:00Z')
    assert.match(directNote({ sent: [{ label: 'Vladislav', text: 'Начал?' }], failed: [], skipped: [], collect: true, deadlineAt: at, live: true }), /Ответы пришлю сразу, как напишут/)
    assert.match(directNote({ sent: [{ label: 'Vladislav', text: 'Начал?' }], failed: [], skipped: [], collect: true, deadlineAt: at }), /Отчёт пришлю к 12:48/)
    assert.match(sentNote({ sent: 2, failed: 0, skipped: [], collect: true, deadlineAt: at, live: true }), /Ответы пришлю сразу/)
    assert.match(confirmText({ topic: 'т', collect: true, deadlineAt: at, count: 2, links: [], live: true }), /каждый ответ пришлю сразу/)
  })
})

describe('Яну про автоначисления', () => {
  test('одним сообщением, по людям через пустую строку, строка на начисление', () => {
    const text = ownerAutoText([
      { user: { name: 'Денис Костоглодов' }, prizePoints: 1, title: 'Личная задача закрыта в срок', taskTitle: 'Подписка ChatGPT' },
      { user: { name: 'Роман Котов' }, prizePoints: -2, title: 'После 10:00 не стоит ни одной задачи', taskTitle: null },
      { user: { name: 'Денис Костоглодов' }, prizePoints: -2.5, title: 'Просрочена личная задача', taskTitle: 'Отчёт' },
    ])
    const blocks = text.split('\n\n')
    assert.equal(blocks.length, 4)
    assert.match(blocks[1], /^<b>Денис Костоглодов<\/b>\nЛичная задача закрыта в срок «Подписка ChatGPT», \+1 балл\nПросрочена личная задача «Отчёт», −2,5 балла$/)
    assert.match(blocks[2], /^<b>Роман Котов<\/b>\nПосле 10:00 не стоит ни одной задачи, −2 балла$/)
    assert.doesNotMatch(text, /агент сам|—/)
  })
})
