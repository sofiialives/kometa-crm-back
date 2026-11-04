import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { prisma } from '../../config/prisma.js'
import { createDraft, decideDraft, foreignText, reportText, roundStatus, sentNote } from '../agent/rounds.js'
import { CANDIDATES_MAX, MENTIONS_MAX, allTitlesDone, foreignTitles, quotedTitles, sameTitle } from '../agent/roundTasks.js'
import { patch } from './patch.js'

const denis = { id: 'denis', name: 'Денис Лебедев', role: 'staff', active: true, departmentId: 'd', department: { name: 'SMM' } }
const anton = { id: 'anton', name: 'Антон Орлов', role: 'staff', active: true, departmentId: 'd', department: { name: 'SMM' } }
const POSTS = 'Десять постов на MMGP и bits.media'
const ADMIN = { id: 'owner', role: 'admin' }
const problemsOf = async (items, viewer = ADMIN) => (await foreignTitles(items, viewer)).problems
const task = (patchIn = {}) => ({ id: 't1', title: POSTS, status: 'today', ownerId: 'anton', owner: anton, ...patchIn })

describe('названия задач в тексте поручения', () => {
  test('названия в кавычках любого вида, без повторов', () => {
    assert.deepEqual(quotedTitles('Денис, как «Макет баннера» и «Макет баннера»? Ещё «Посты»'), ['Макет баннера', 'Посты'])
    assert.deepEqual(quotedTitles('как "Макет баннера", „Лендинг“, “Визитка” и \'Сайт\''), ['Макет баннера', 'Лендинг', 'Визитка', 'Сайт'])
    assert.deepEqual(quotedTitles('без кавычек, только слова'), [])
  })

  test('короткие упоминания отбрасываем сразу, и не больше двадцати названий', () => {
    assert.deepEqual(quotedTitles('«а» и «ок» и «Сайт»'), ['Сайт'])
    const text = Array.from({ length: 50 }, (_, i) => `«Задача ${i}»`).join(' ')
    assert.equal(quotedTitles(text).length, MENTIONS_MAX)
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
  /** open — открытые задачи области смотрящего, own — задачи адресатов любого статуса. */
  const rows = (t, { open = [], own = [] }) => patch(t, prisma.task, 'findMany', async ({ where }) => (where.AND.some((c) => c.owner) ? open : own))

  test('точное название чужой открытой задачи в тексте, с кавычками или без — это место', async (t) => {
    rows(t, { open: [task()] })
    for (const text of [`Денис, как «${POSTS}»?`, `Денис, как "${POSTS}"?`, `Денис, как ${POSTS.toUpperCase()} идёт?`]) {
      const found = await problemsOf([{ userId: 'denis', text }], ADMIN)
      assert.equal(found.length, 1, text)
      assert.equal(found[0].userId, 'denis')
      assert.equal(found[0].title, POSTS)
      assert.deepEqual(found[0].owners.map((o) => o.id), ['anton'])
    }
  })

  test('сокращение чужого названия — не повод считать задачу чужой', async (t) => {
    rows(t, { open: [task()] })
    assert.deepEqual(await problemsOf([{ userId: 'denis', text: 'Денис, как «Десять постов»?' }], ADMIN), [])
  })

  test('название целыми словами: «макет баннера» не найдётся в «макет баннерами»', async (t) => {
    rows(t, { open: [task({ title: 'Макет баннера' })] })
    assert.equal((await problemsOf([{ userId: 'denis', text: 'Как макет баннера?' }], ADMIN)).length, 1)
    assert.equal((await problemsOf([{ userId: 'denis', text: 'Как макет баннерами?' }], ADMIN)).length, 0)
  })

  test('короткие и общие названия чужих задач не проверяем', async (t) => {
    rows(t, { open: [task({ title: 'Отчёт' })] })
    assert.deepEqual(await problemsOf([{ userId: 'denis', text: 'Денис, пришли отчёт по «Отчёт»' }], ADMIN), [])
  })

  test('у адресата есть своя открытая задача с таким названием — всё в порядке', async (t) => {
    const calls = rows(t, { open: [task(), task({ id: 't2', ownerId: 'denis', owner: denis })] })
    assert.deepEqual(await problemsOf([{ userId: 'denis', text: `Как «${POSTS}»?` }], ADMIN), [])
    assert.equal(calls.length, 1)
  })

  test('своя задача адресата уже сделана — она есть во втором запросе, ошибки нет', async (t) => {
    const calls = rows(t, { open: [task()], own: [task({ id: 't3', ownerId: 'denis', owner: denis, status: 'done' })] })
    assert.deepEqual(await problemsOf([{ userId: 'denis', text: `Как «${POSTS}»?` }], ADMIN), [])
    assert.equal(calls.length, 2)
  })

  test('назвали более длинную свою задачу, в которой чужое название лишь часть — не чужая', async (t) => {
    rows(t, { open: [task({ title: 'Макет баннера' }), task({ id: 't4', title: 'Макет баннера для Румикс', ownerId: 'denis', owner: denis })] })
    assert.deepEqual(await problemsOf([{ userId: 'denis', text: 'Как «Макет баннера для Румикс»?' }], ADMIN), [])
    assert.equal((await problemsOf([{ userId: 'denis', text: 'Как «Макет баннера» для Румикс?' }], ADMIN)).length, 0)
  })

  test('в тексте нет названий чужих задач — во второй запрос не ходим', async (t) => {
    const calls = rows(t, { open: [task()] })
    assert.deepEqual(await problemsOf([{ userId: 'denis', text: 'Привет, как дела' }], ADMIN), [])
    assert.equal(calls.length, 1)
  })

  test('в запросе фильтр видимости, только открытые и круг владельцев смотрящего', async (t) => {
    const calls = rows(t, {})
    await foreignTitles([{ userId: 'denis', text: 'Как дела' }], ADMIN)
    const where = calls[0][0].where
    assert.equal(where.AND[0].OR[1].work.status, 'active')
    assert.deepEqual(where.AND[1], { status: { in: ['today', 'progress'] } })
    assert.ok(where.AND[2].owner)
  })

  test('выборка упёрлась в предел — проверка неполная, и это видно, а не молчит', async (t) => {
    const many = Array.from({ length: CANDIDATES_MAX + 1 }, (_, i) => task({ id: `x${i}`, title: `Задача номер ${i}` }))
    rows(t, { open: many })
    assert.deepEqual(await foreignTitles([{ userId: 'denis', text: 'Как дела' }], ADMIN), { problems: [], incomplete: true })
    rows(t, { open: [task()], own: many })
    assert.equal((await foreignTitles([{ userId: 'denis', text: `Как «${POSTS}»?` }], ADMIN)).incomplete, true)
  })

  test('мест с чужими задачами показываем не больше двадцати', async (t) => {
    const open = Array.from({ length: 30 }, (_, i) => task({ id: `x${i}`, title: `Большая задача номер ${i}` }))
    rows(t, { open })
    const text = open.map((x) => x.title).join(', ')
    assert.equal((await problemsOf([{ userId: 'denis', text }])).length, 20)
  })

  test('искать можно только среди адресатов, людей смотрящего и его самого, чужой отдел «не найден»', async (t) => {
    const calls = rows(t, {})
    const lead = { id: 'lead', role: 'lead', departmentId: 'design' }
    await foreignTitles([{ userId: 'roman', text: 'Роман, как дела' }], lead)
    const scope = calls[0][0].where.AND.find((c) => c.owner).owner
    assert.deepEqual(scope, { OR: [{ role: 'staff', active: true, departmentId: 'design', id: { not: 'lead' } }, { id: 'lead' }, { id: { in: ['roman'] } }] })
    await foreignTitles([{ userId: 'roman', text: 'Роман, как дела' }], ADMIN)
    assert.deepEqual(calls[1][0].where.AND.find((c) => c.owner).owner.OR[0], { role: { in: ['staff', 'lead'] }, active: true })
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

  test('message_people: проверка неполная — черновика нет, модель получает ошибку', async (t) => {
    patch(t, prisma.user, 'findFirst', async () => ({ ...denis, telegram: { chatId: '1002' } }))
    patch(t, prisma.task, 'findMany', async () => Array.from({ length: CANDIDATES_MAX + 1 }, (_, i) => task({ id: `x${i}` })))
    const created = patch(t, prisma.botRound, 'create', async () => ({ id: 'r1' }))
    const res = await createDraft({ id: 'owner', role: 'admin' }, '9001', { topic: 'Как дела', minutes: 60, collect: true, messages: [{ person_id: 'denis', text: 'Денис, привет. Как дела?' }] })
    assert.equal(res.shown, false)
    assert.match(res.text, /проверить названия задач не вышло/)
    assert.equal(created.length, 0)
  })
})

describe('свежие задачи при отправке', () => {
  test('все названные задачи человека сделаны — да; хоть одна открыта, нет названий или таких задач — нет', async (t) => {
    const mine = (patchIn) => task({ ownerId: 'denis', owner: denis, ...patchIn })
    const calls = patch(t, prisma.task, 'findMany', async () => [mine({ status: 'done' })])
    assert.equal(await allTitlesDone('denis', `Как «${POSTS}»?`), true)
    assert.equal(calls[0][0].where.AND[1].ownerId, 'denis')
    assert.equal(await allTitlesDone('denis', 'Привет, как дела'), false)
    assert.equal(await allTitlesDone('denis', 'Как «Что-то другое»?'), false)
    patch(t, prisma.task, 'findMany', async () => [mine({ status: 'done' }), mine({ id: 't2', title: 'Макет баннера', status: 'progress' })])
    assert.equal(await allTitlesDone('denis', `Как «${POSTS}» и «Макет баннера»?`), false)
    assert.equal(await allTitlesDone('denis', `Как «${POSTS}»?`), true)
  })

  test('в отчёте отдельно сказано, кому не писали и почему', () => {
    const at = new Date('2026-11-04T10:00:00Z')
    const text = reportText({
      round: { topic: 'Как дела', sentAt: at },
      answered: [], silent: [{ userId: 'a', label: '(SMM) Антон' }], failed: [],
      skipped: [{ userId: 'd', label: '(SMM) Денис' }],
      ai: null,
    })
    assert.match(text, /Не ответили<\/b>\n• \(SMM\) Антон/)
    assert.match(text, /Не писал, задачи уже сделаны<\/b>\n• \(SMM\) Денис/)
  })

  test('get_round: кому не писали — так и сказано, и в «написал» он не входит', async (t) => {
    patch(t, prisma.botRound, 'findFirst', async () => ({ id: 'r1', topic: 'Как дела', status: 'sent', sentAt: new Date('2026-11-04T10:00:00Z'), deadlineAt: new Date('2026-11-04T12:00:00Z') }))
    patch(t, prisma.botRoundTarget, 'findMany', async () => [
      { userId: 'denis', user: denis, status: 'skipped', summary: null, messages: [] },
      { userId: 'anton', user: anton, status: 'sent', summary: null, messages: [] },
    ])
    const text = await roundStatus({ id: 'owner', role: 'admin' })
    assert.match(text, /Написал 1, ответили 0/)
    assert.match(text, /\(SMM\) Денис, не писал, его задачи уже сделаны/)
  })

  test('выборка задач человека упёрлась в предел — не уверены, пишем как обычно', async (t) => {
    patch(t, prisma.task, 'findMany', async () => Array.from({ length: 300 }, (_, i) => task({ id: `d${i}`, ownerId: 'denis', owner: denis, status: 'done' })))
    assert.equal(await allTitlesDone('denis', `Как «${POSTS}»?`), false)
  })

  test('подтверждение: сколько отправил и кому не писал', () => {
    const deadlineAt = new Date('2026-11-04T14:00:00Z')
    assert.equal(sentNote({ sent: 2, failed: 1, skipped: [], collect: true, deadlineAt }), 'Отправил 2, не дошло 1. Отчёт пришлю к 17:00')
    assert.equal(sentNote({ sent: 1, failed: 0, skipped: ['(SMM) Денис'], collect: false, deadlineAt }), 'Отправил 1\nНе отправил (SMM) Денис, задачи уже сделаны')
    assert.equal(sentNote({ sent: 0, failed: 0, skipped: ['(SMM) Денис', '(SMM) Антон'], collect: true, deadlineAt }), 'Никому не отправил\nНе отправил (SMM) Денис, задачи уже сделаны\nНе отправил (SMM) Антон, задачи уже сделаны')
  })

  /** Подмена базы и телеграма для кнопки «Отправить»: возвращает, что записали и кому написали. */
  function pressGo(t, { texts, tasksByOwner }) {
    const people = { denis: { ...denis, telegram: { chatId: '1002' } }, roman: { id: 'roman', name: 'Роман Котов', role: 'staff', active: true, departmentId: 'd', department: { name: 'Дизайн' }, telegram: { chatId: '1001' } } }
    const now = new Date('2026-11-04T12:00:00Z')
    patch(t, prisma.botRound, 'findUnique', async () => ({ id: 'r1', ownerId: 'owner', status: 'draft', collect: true, createdAt: new Date('2026-11-04T10:00:00Z'), deadlineAt: new Date('2026-11-04T11:00:00Z') }))
    const closed = patch(t, prisma.botRound, 'update', async () => ({}))
    patch(t, prisma.botRound, 'updateMany', async () => ({ count: 1 }))
    patch(t, prisma.botRoundTarget, 'findMany', async () => Object.keys(texts).map((userId) => ({ id: `target-${userId}`, userId, text: texts[userId] })))
    const updates = patch(t, prisma.botRoundTarget, 'update', async () => ({}))
    patch(t, prisma.user, 'findFirst', async ({ where }) => people[where.AND[1].id])
    patch(t, prisma.task, 'findMany', async ({ where }) => tasksByOwner[where.AND[1].ownerId] ?? [])
    patch(t, prisma.telegramLink, 'findFirst', async ({ where }) => ({ chatId: people[where.userId].telegram.chatId }))
    patch(t, prisma.botMessage, 'create', async () => ({ id: 'm' }))
    const written = []
    const realFetch = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      written.push(JSON.parse(init.body))
      return new Response(JSON.stringify({ ok: true, result: { message_id: written.length } }))
    }
    t.after(() => { globalThis.fetch = realFetch })
    return { run: () => decideDraft({ id: 'owner', role: 'admin' }, 'r1', true, now), updates, closed, written }
  }

  test('кнопка «Отправить»: у кого всё сделано, тому не пишем, остальным уходит, подтверждение говорит об этом', async (t) => {
    const run = pressGo(t, {
      texts: { denis: `Денис, как «${POSTS}»?`, roman: 'Роман, как «Баннер для Румикс»?' },
      tasksByOwner: { denis: [task({ ownerId: 'denis', owner: denis, status: 'done' })], roman: [task({ id: 't3', title: 'Баннер для Румикс', ownerId: 'roman', status: 'progress' })] },
    })
    const note = await run.run()
    assert.deepEqual(run.written.map((w) => w.chat_id), ['1001'])
    assert.deepEqual(run.updates.map(([a]) => [a.where.id, a.data.status]), [['target-denis', 'skipped'], ['target-roman', 'sent']])
    assert.match(note, /^Отправил 1\. Отчёт пришлю к \d\d:\d\d\nНе отправил \(SMM\) Денис, задачи уже сделаны$/)
    assert.equal(run.closed.length, 0)
  })

  test('сделано у всех — никому не пишем, поручение закрыто без отчёта', async (t) => {
    const run = pressGo(t, {
      texts: { denis: `Денис, как «${POSTS}»?` },
      tasksByOwner: { denis: [task({ ownerId: 'denis', owner: denis, status: 'done' })] },
    })
    const note = await run.run()
    assert.equal(run.written.length, 0)
    assert.match(note, /^Никому не отправил\nНе отправил \(SMM\) Денис, задачи уже сделаны$/)
    assert.equal(run.closed[0][0].data.status, 'closed')
  })

  test('не смогли прочитать задачи — сообщение уходит как было', async (t) => {
    const run = pressGo(t, { texts: { denis: `Денис, как «${POSTS}»?` }, tasksByOwner: {} })
    patch(t, prisma.task, 'findMany', async () => { throw new Error('база') })
    const note = await run.run()
    assert.equal(run.written.length, 1)
    assert.match(note, /^Отправил 1\./)
  })
})
