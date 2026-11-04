import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { prisma } from '../../config/prisma.js'
import { createDraft, foreignText } from '../agent/rounds.js'
import { foreignTitles, quotedTitles, sameTitle } from '../agent/roundTasks.js'
import { patch } from './patch.js'

const denis = { id: 'denis', name: 'Денис Лебедев', role: 'staff', active: true, departmentId: 'd', department: { name: 'SMM' } }
const anton = { id: 'anton', name: 'Антон Орлов', role: 'staff', active: true, departmentId: 'd', department: { name: 'SMM' } }
const POSTS = 'Десять постов на MMGP и bits.media'
const task = (patchIn = {}) => ({ id: 't1', title: POSTS, status: 'today', ownerId: 'anton', owner: anton, ...patchIn })

describe('названия задач в тексте поручения', () => {
  test('берём названия в ёлочках, без повторов', () => {
    assert.deepEqual(quotedTitles('Денис, как «Макет баннера» и «Макет баннера»? Ещё «Посты»'), ['Макет баннера', 'Посты'])
    assert.deepEqual(quotedTitles('без ёлочек, только "кавычки"'), [])
  })

  test('то же название с точностью до регистра, ё и знаков; сокращение не короче шести букв', () => {
    assert.equal(sameTitle('десять ПОСТОВ на mmgp и bits media', POSTS), true)
    assert.equal(sameTitle('Десять постов', POSTS), true)
    assert.equal(sameTitle('Посты', POSTS), false)
    assert.equal(sameTitle('Елка', 'ёлка'), true)
    assert.equal(sameTitle('', POSTS), false)
  })
})

describe('чужая задача в сообщении человеку', () => {
  test('название совпало с открытой задачей другого и ни с одной задачей адресата — это место', async (t) => {
    patch(t, prisma.task, 'findMany', async () => [task()])
    const found = await foreignTitles([{ userId: 'denis', text: `Денис, как «${POSTS}»?` }])
    assert.equal(found.length, 1)
    assert.equal(found[0].userId, 'denis')
    assert.equal(found[0].title, POSTS)
    assert.deepEqual(found[0].owners.map((o) => o.id), ['anton'])
  })

  test('у адресата есть своя задача с таким названием — всё в порядке', async (t) => {
    patch(t, prisma.task, 'findMany', async () => [task(), task({ id: 't2', ownerId: 'denis', owner: denis })])
    assert.deepEqual(await foreignTitles([{ userId: 'denis', text: `Как «${POSTS}»?` }]), [])
  })

  test('чужая задача уже сделана, названия нет нигде, нет ёлочек — не ошибка', async (t) => {
    const calls = patch(t, prisma.task, 'findMany', async () => [task({ status: 'done' })])
    assert.deepEqual(await foreignTitles([{ userId: 'denis', text: `Как «${POSTS}»?` }, { userId: 'x', text: 'Привет, как дела' }, { userId: 'y', text: 'Что с «Неизвестной»?' }]), [])
    assert.equal(calls.length, 1)
  })

  test('без ёлочек в базу не ходим', async (t) => {
    const calls = patch(t, prisma.task, 'findMany', async () => [])
    assert.deepEqual(await foreignTitles([{ userId: 'denis', text: 'Привет' }]), [])
    assert.equal(calls.length, 0)
  })

  test('в запросе фильтр видимости и поиск по названию без учёта регистра', async (t) => {
    const calls = patch(t, prisma.task, 'findMany', async () => [])
    await foreignTitles([{ userId: 'denis', text: 'Как «Макет»?' }])
    const where = calls[0][0].where
    assert.equal(where.AND[0].OR[1].work.status, 'active')
    assert.deepEqual(where.AND.at(-1).OR, [{ title: { contains: 'Макет', mode: 'insensitive' } }])
  })

  test('текст для модели: кому, какая задача, чья; чужого из другого отдела не называем', () => {
    const labels = new Map([['denis', '(SMM) Денис']])
    const problems = [{ userId: 'denis', title: POSTS, owners: [anton] }]
    assert.match(foreignText(problems, labels, { role: 'admin' }), /\(SMM\) Денис, «Десять постов на MMGP и bits\.media» это задача \(SMM\) Антон, а у него такой нет/)
    assert.match(foreignText(problems, labels, { role: 'lead', id: 'l', departmentId: 'other' }), /это задача другого человека/)
    assert.match(foreignText(problems, labels, { role: 'admin' }), /Черновик не создан/)
  })

  test('message_people: чужая задача — ошибка модели, черновика и рассылки нет', async (t) => {
    patch(t, prisma.user, 'findFirst', async () => ({ ...denis, telegram: { chatId: '1002' } }))
    patch(t, prisma.task, 'findMany', async () => [task()])
    const created = patch(t, prisma.botRound, 'create', async () => ({ id: 'r1' }))
    const cancelled = patch(t, prisma.botRound, 'updateMany', async () => ({ count: 0 }))
    const res = await createDraft({ id: 'owner', role: 'admin' }, '9001', { topic: 'Как дела', minutes: 60, collect: true, messages: [{ person_id: 'denis', text: `Денис, привет. Как идёт «${POSTS}»?` }] })
    assert.equal(res.shown, false)
    assert.match(res.text, /Черновик не создан/)
    assert.match(res.text, /\(SMM\) Денис/)
    assert.equal(created.length, 0)
    assert.equal(cancelled.length, 0)
  })
})
