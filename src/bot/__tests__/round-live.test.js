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
  test('одним сообщением на всех, по-русски, без «агент сам начислено»', () => {
    const text = ownerAutoText([
      { user: { name: 'Денис Костоглодов' }, prizePoints: 1, title: 'Личная задача закрыта в срок', taskTitle: 'Подписка ChatGPT' },
      { user: { name: 'Роман Котов' }, prizePoints: -2, title: 'Не расставил задачи до 10:00', taskTitle: null },
    ])
    assert.equal(text.split('\n').length, 4)
    assert.match(text, /Денис Костоглодов, \+1 балл, личная задача закрыта в срок «Подписка ChatGPT»/)
    assert.match(text, /Роман Котов, −2 балла|Роман Котов, -2 балла/)
    assert.doesNotMatch(text, /агент сам|—/)
  })
})

describe('тёзки по словам просьбы', () => {
  const vlad = { id: 'v', name: 'Vladislav' }
  const alex = { id: 'a', name: 'Alex' }
  const sashaM = { id: 's1', name: 'Alexandr' }
  const sashaF = { id: 's2', name: 'Александра Ким' }
  const volkov = { id: 'n1', name: 'Николай Волков' }
  const petrov = { id: 'n2', name: 'Николай Петров' }
  const team = [vlad, alex, sashaM, sashaF, volkov, petrov]
  test('Влад и Алекс разные люди: черновик не нужен', () => {
    assert.equal(namesakeIn(team, [vlad, alex], ['Узнай у Влада и Алекса']), false)
  })
  test('«Саше»: Alexandr и Александра, даже если выбраны оба', () => {
    assert.equal(namesakeIn(team, [sashaM], ['Напиши Саше']), true)
    assert.equal(namesakeIn(team, [sashaM, sashaF], ['Напиши Саше']), true)
  })
  test('имя и фамилия различают тёзок, одно имя нет', () => {
    assert.equal(namesakeIn(team, [volkov], ['Напиши Николаю Волкову']), false)
    assert.equal(namesakeIn(team, [volkov], ['Напиши Николаю']), true)
  })
})
