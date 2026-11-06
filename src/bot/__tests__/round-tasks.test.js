import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { prisma } from '../../config/prisma.js'
import { createDraft, decideDraft, foreignText, reportText, roundStatus, sentNote } from '../agent/rounds.js'
import { MENTIONS_MAX, OWN_MAX, SCAN_MAX, allTitlesDone, foreignTitles, quotedTitles, sameTitle } from '../agent/roundTasks.js'
import { patch } from './patch.js'

const denis = { id: 'denis', name: 'Денис Лебедев', role: 'staff', active: true, departmentId: 'd', department: { name: 'SMM' } }
const anton = { id: 'anton', name: 'Антон Орлов', role: 'staff', active: true, departmentId: 'd', department: { name: 'SMM' } }
const POSTS = 'Десять постов на MMGP и bits.media'
const ADMIN = { id: 'owner', role: 'admin' }
const problemsOf = async (items, viewer = ADMIN) => (await foreignTitles(items, viewer)).problems
const task = (patchIn = {}) => ({ id: 't1', title: POSTS, status: 'today', ownerId: 'anton', owner: anton, ...patchIn })

describe('названия задач в тексте поручения', () => {
  test('названия в кавычках любого вида, без повторов', () => {
    assert.deepEqual(quotedTitles('Денис, как «Макет баннера» и «Макет баннера»? Ещё «Посты»'), { titles: ['Макет баннера', 'Посты'], truncated: false })
    assert.deepEqual(quotedTitles('как "Макет баннера", „Лендинг“, “Визитка” и \'Сайт\'').titles, ['Макет баннера', 'Лендинг', 'Визитка', 'Сайт'])
    assert.deepEqual(quotedTitles('без кавычек, только слова'), { titles: [], truncated: false })
  })

  test('короткие упоминания отбрасываем сразу, больше двадцати не берём, и об этом сказано', () => {
    assert.deepEqual(quotedTitles('«а» и «ок» и «Сайт»'), { titles: ['Сайт'], truncated: true })
    const text = Array.from({ length: 50 }, (_, i) => `«Задача ${i}»`).join(' ')
    const many = quotedTitles(text)
    assert.equal(many.titles.length, MENTIONS_MAX)
    assert.equal(many.truncated, true)
    assert.equal(quotedTitles(Array.from({ length: MENTIONS_MAX }, (_, i) => `«Задача ${i}»`).join(' ')).truncated, false)
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
  /**
   * open — открытые задачи области смотрящего (одним запросом; владельцы
   * найденных читаются отдельно из users), own — задачи адресатов любого статуса.
   */
  const rows = (t, { open = [], own = [] }) => {
    patch(t, prisma.user, 'findMany', async ({ where }) => [...new Map(open.filter((x) => where.id.in.includes(x.ownerId)).map((x) => [x.ownerId, x.owner])).values()])
    return patch(t, prisma.task, 'findMany', async ({ where, take }) => (where.AND.some((c) => c.owner) ? open.slice(0, take) : own))
  }

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

  test('упоминание от шести букв, которое входит в чужую задачу и не совпадает со своими, — чужая задача', async (t) => {
    rows(t, { open: [task()], own: [task({ id: 'd1', title: 'Баннер для Румикс', ownerId: 'denis', status: 'progress' })] })
    const found = await problemsOf([{ userId: 'denis', text: 'Денис, как «Десять постов»?' }])
    assert.equal(found.length, 1)
    assert.equal(found[0].title, POSTS)
  })

  test('ложных срабатываний на свои задачи нет: упоминание входит и в свою задачу адресата', async (t) => {
    rows(t, { open: [task()], own: [task({ id: 'd2', title: 'Десять постов для блога', ownerId: 'denis', status: 'done' })] })
    assert.deepEqual(await problemsOf([{ userId: 'denis', text: 'Денис, как «Десять постов»?' }]), [])
    rows(t, { open: [task(), task({ id: 'd3', title: 'Десять постов для блога', ownerId: 'denis' })] })
    assert.deepEqual(await problemsOf([{ userId: 'denis', text: 'Денис, как «Десять постов»?' }]), [])
  })

  test('упоминание короче шести букв сокращением не считается', async (t) => {
    rows(t, { open: [task({ title: 'Макет баннера' })] })
    assert.deepEqual(await problemsOf([{ userId: 'denis', text: 'Денис, как «Макет»?' }]), [])
  })

  test('название целыми словами: «макет баннера» не найдётся в «макет баннерами»', async (t) => {
    rows(t, { open: [task({ title: 'Макет баннера' })] })
    assert.equal((await problemsOf([{ userId: 'denis', text: 'Как макет баннера?' }], ADMIN)).length, 1)
    assert.equal((await problemsOf([{ userId: 'denis', text: 'Как макет баннерами?' }], ADMIN)).length, 0)
  })

  test('короткое название чужой задачи без кавычек это просто слово, в кавычках — чужая задача', async (t) => {
    rows(t, { open: [task({ title: 'Отчёт' })], own: [] })
    // Ложный отказ хуже пропуска: «пришли отчёт» не задача Антона.
    assert.deepEqual(await problemsOf([{ userId: 'denis', text: 'Денис, пришли отчёт по SEO' }]), [])
    assert.equal((await problemsOf([{ userId: 'denis', text: 'Денис, как «Отчёт»?' }])).length, 1)
    assert.deepEqual(await problemsOf([{ userId: 'denis', text: 'Денис, как «Отчётность»?' }]), [])
    assert.deepEqual(await problemsOf([{ userId: 'denis', text: 'Денис, привет' }]), [])
  })

  test('название из двух слов или длинное ищем и без кавычек', async (t) => {
    rows(t, { open: [task({ title: 'Макет баннера' }), task({ id: 't9', title: 'Документация' })], own: [] })
    assert.equal((await problemsOf([{ userId: 'denis', text: 'Денис, как макет баннера?' }])).length, 1)
    assert.equal((await problemsOf([{ userId: 'denis', text: 'Денис, что с документация?' }])).length, 1)
  })

  test('короткое название, которое входит в свою задачу адресата, чужим не считается', async (t) => {
    rows(t, { open: [task({ title: 'Отчёт' })], own: [task({ id: 'd4', title: 'Отчёт по SEO', ownerId: 'denis', status: 'progress' })] })
    assert.deepEqual(await problemsOf([{ userId: 'denis', text: 'Денис, пришли отчёт по SEO' }]), [])
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

  test('своя задача, сделанная месяц назад, не прикрывает живую чужую с тем же названием', async (t) => {
    const old = task({ id: 't5', ownerId: 'denis', owner: denis, status: 'done', doneAt: new Date(Date.now() - 30 * 24 * 3600e3) })
    patch(t, prisma.user, 'findMany', async () => [anton])
    patch(t, prisma.task, 'findMany', async ({ where }) => {
      if (where.AND.some((c) => c.owner)) return [task()]
      // Запрос без даты отсечки вернул бы и старую задачу, как раньше.
      const since = where.AND.flatMap((c) => c.OR ?? []).find((o) => o.doneAt)?.doneAt.gte
      return since ? [old].filter((x) => x.status !== 'done' || x.doneAt >= since) : [old]
    })
    const found = await problemsOf([{ userId: 'denis', text: `Как «${POSTS}»?` }], ADMIN)
    assert.equal(found.length, 1)
    assert.deepEqual(found[0].owners.map((o) => o.id), ['anton'])
  })

  test('назвали более длинную свою задачу, в которой чужое название лишь часть — не чужая', async (t) => {
    rows(t, { open: [task({ title: 'Макет баннера' }), task({ id: 't4', title: 'Макет баннера для Румикс', ownerId: 'denis', owner: denis })] })
    assert.deepEqual(await problemsOf([{ userId: 'denis', text: 'Как «Макет баннера для Румикс»?' }], ADMIN), [])
    assert.equal((await problemsOf([{ userId: 'denis', text: 'Как «Макет баннера» для Румикс?' }], ADMIN)).length, 0)
  })

  test('свои задачи адресатов читаются одним запросом по ownerId, без отбора по названиям из текста', async (t) => {
    const calls = rows(t, { open: [task()] })
    const text = `Денис, как «${POSTS}» и ${Array.from({ length: 50 }, (_, i) => `«Задача ${i}»`).join(' ')}`
    await foreignTitles([{ userId: 'denis', text }, { userId: 'roman', text }], ADMIN)
    const own = calls[1][0].where
    assert.equal(calls.length, 2)
    assert.deepEqual(own.AND[1], { ownerId: { in: ['denis', 'roman'] } })
    assert.doesNotMatch(JSON.stringify(own), /contains|Задача/)
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

  test('область из 4999 задач проверяется одним запросом, ровно 5000 — неполная проверка', async (t) => {
    const filler = (n) => Array.from({ length: n }, (_, i) => task({ id: `a${i}`, title: `Другая задача ${i}`, ownerId: 'x', owner: anton }))
    const calls = rows(t, { open: [...filler(SCAN_MAX - 2), task({ id: 'z-posts' })] })
    const res = await foreignTitles([{ userId: 'denis', text: `Денис, как «${POSTS}»?` }], ADMIN)
    assert.equal(res.incomplete, false)
    assert.equal(res.problems.length, 1)
    assert.equal(calls.filter(([q]) => q.where.AND.some((c) => c.owner)).length, 1)
    assert.equal(calls[0][0].take, SCAN_MAX)
    assert.deepEqual(calls[0][0].select, { id: true, title: true, ownerId: true })
    rows(t, { open: filler(SCAN_MAX) })
    assert.deepEqual(await foreignTitles([{ userId: 'denis', text: 'Как дела' }], ADMIN), { problems: [], incomplete: true })
  })

  test('упоминаний для сокращений берём не больше MENTIONS_MAX после дедупликации', async (t) => {
    rows(t, { open: [task({ title: 'Задача номер 25 про сайт' })] })
    const text = Array.from({ length: 30 }, (_, i) => `«Задача номер ${String(i).padStart(2, '0')}» «Задача номер ${String(i).padStart(2, '0')}»`).join(' ')
    // Двадцать пятое упоминание в список не попало и сокращением не считается.
    assert.deepEqual(await problemsOf([{ userId: 'denis', text }]), [])
    rows(t, { open: [task({ title: 'Задача номер 03 про сайт' })] })
    assert.equal((await problemsOf([{ userId: 'denis', text }])).length, 1)
  })

  test('свои задачи адресатов не влезли в предел — тоже неполная', async (t) => {
    rows(t, { open: [task()], own: Array.from({ length: OWN_MAX + 1 }, (_, i) => task({ id: `y${i}`, ownerId: 'denis', status: 'done' })) })
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
    const labels = new Map([['denis', 'Денис, SMM']])
    const problems = [{ userId: 'denis', title: POSTS, owners: [anton] }]
    assert.match(foreignText(problems, labels, { role: 'admin' }), /Денис, SMM, «Десять постов на MMGP и bits\.media» это задача Антон, SMM, а у него такой нет/)
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
    assert.match(res.text, /Денис, SMM/)
    assert.equal(created.length, 0)
    assert.equal(cancelled.length, 0)
  })

  test('message_people: проверка неполная — поручение не блокируется, черновик создаётся', async (t) => {
    patch(t, prisma.user, 'findFirst', async () => ({ ...denis, telegram: { chatId: '1002' } }))
    patch(t, prisma.task, 'findMany', async ({ take }) => Array.from({ length: take }, (_, i) => task({ id: `x${i}`, title: `Другая задача ${i}` })))
    patch(t, prisma.botRound, 'updateMany', async () => ({ count: 0 }))
    const created = patch(t, prisma.botRound, 'create', async () => { throw new Error('дошли до создания') })
    await assert.rejects(
      createDraft({ id: 'owner', role: 'admin' }, '9001', { topic: 'Как дела', minutes: 60, collect: true, messages: [{ person_id: 'denis', text: 'Денис, привет. Как дела?' }] }),
      /дошли до создания/,
    )
    assert.equal(created.length, 1)
  })
})

describe('свежие задачи при отправке', () => {
  test('все названные задачи человека сделаны — да; хоть одна открыта, нет названий или таких задач — нет', async (t) => {
    const mine = (patchIn) => task({ ownerId: 'denis', owner: denis, ...patchIn })
    const calls = patch(t, prisma.task, 'findMany', async () => [mine({ status: 'done' })])
    assert.equal(await allTitlesDone('denis', `Как «${POSTS}»?`), true)
    assert.deepEqual(calls[0][0].where.AND[1].ownerId, { in: ['denis'] })
    assert.equal(await allTitlesDone('denis', 'Привет, как дела'), false)
    assert.equal(await allTitlesDone('denis', 'Как «Что-то другое»?'), false)
    patch(t, prisma.task, 'findMany', async () => [mine({ status: 'done' }), mine({ id: 't2', title: 'Макет баннера', status: 'progress' })])
    assert.equal(await allTitlesDone('denis', `Как «${POSTS}» и «Макет баннера»?`), false)
    assert.equal(await allTitlesDone('denis', `Как «${POSTS}»?`), true)
  })

  test('не писать можно, только если каждое упоминание найдено сделанным; иначе сообщение уходит как обычно', async (t) => {
    const mine = (patchIn) => task({ ownerId: 'denis', owner: denis, ...patchIn })
    patch(t, prisma.task, 'findMany', async () => [mine({ status: 'done' }), mine({ id: 't2', title: 'Макет баннера', status: 'done' })])
    assert.equal(await allTitlesDone('denis', `Как «${POSTS}» и «Макет баннера»?`), true)
    // Второе упоминание, например клиент, среди задач не нашлось: проверено не всё.
    assert.equal(await allTitlesDone('denis', `Как «${POSTS}» для «Румикс»?`), false)
    // Короткое упоминание отброшено до запроса: список неполный.
    assert.equal(await allTitlesDone('denis', `Как «${POSTS}» и «ок»?`), false)
    // Больше двадцати упоминаний: остальные не проверены.
    const titles = Array.from({ length: MENTIONS_MAX + 1 }, (_, i) => `Задача номер ${i}`)
    patch(t, prisma.task, 'findMany', async () => titles.map((title, i) => mine({ id: `d${i}`, title, status: 'done' })))
    assert.equal(await allTitlesDone('denis', titles.slice(0, MENTIONS_MAX).map((x) => `«${x}»`).join(' ')), true)
    assert.equal(await allTitlesDone('denis', titles.map((x) => `«${x}»`).join(' ')), false)
  })

  test('название работы или клиента в кавычках рядом с задачей не мешает понять, что всё сделано', async (t) => {
    const work = { title: 'Цепляющая главная', client: { name: 'ХочуПлачу' } }
    patch(t, prisma.task, 'findMany', async () => [task({ ownerId: 'denis', owner: denis, status: 'done', work })])
    assert.equal(await allTitlesDone('denis', `Как «${POSTS}», ХочуПлачу, «Цепляющая главная»?`), true)
    assert.equal(await allTitlesDone('denis', `Как «${POSTS}» для «ХочуПлачу»?`), true)
    // Только работа без задачи — проверять нечего, пишем.
    assert.equal(await allTitlesDone('denis', 'Как «Цепляющая главная»?'), false)
  })

  test('сделанные давно задачи не читаем, отсечка по дате в запросе', async (t) => {
    const calls = patch(t, prisma.task, 'findMany', async () => [])
    await allTitlesDone('denis', `Как «${POSTS}»?`, new Date('2026-11-06T10:00:00Z'))
    const since = calls[0][0].where.AND.flatMap((c) => c.OR ?? []).find((o) => o.doneAt)?.doneAt.gte
    assert.equal(since.toISOString(), '2026-10-07T10:00:00.000Z')
  })

  test('в отчёте отдельно сказано, кому не писали и почему', () => {
    const at = new Date('2026-11-04T10:00:00Z')
    const text = reportText({
      round: { topic: 'Как дела', sentAt: at },
      answered: [], silent: [{ userId: 'a', label: 'Антон, SMM' }], failed: [],
      skipped: [{ userId: 'd', label: 'Денис, SMM' }],
      ai: null,
    })
    assert.match(text, /Не ответили<\/b>\n• Антон, SMM/)
    assert.match(text, /Не писал, задачи уже сделаны<\/b>\n• Денис, SMM/)
  })

  test('get_round: кому не писали — так и сказано, и в «написал» он не входит', async (t) => {
    patch(t, prisma.botRound, 'findFirst', async () => ({ id: 'r1', topic: 'Как дела', status: 'sent', sentAt: new Date('2026-11-04T10:00:00Z'), deadlineAt: new Date('2026-11-04T12:00:00Z') }))
    patch(t, prisma.botRoundTarget, 'findMany', async () => [
      { userId: 'denis', user: denis, status: 'skipped', summary: null, messages: [] },
      { userId: 'anton', user: anton, status: 'sent', summary: null, messages: [] },
    ])
    const text = await roundStatus({ id: 'owner', role: 'admin' })
    assert.match(text, /Написал 1, ответили 0/)
    assert.match(text, /Денис, SMM, не писал, его задачи уже сделаны/)
  })

  test('выборка задач человека упёрлась в предел — не уверены, пишем как обычно', async (t) => {
    patch(t, prisma.task, 'findMany', async () => Array.from({ length: OWN_MAX + 1 }, (_, i) => task({ id: `d${i}`, ownerId: 'denis', owner: denis, status: 'done' })))
    assert.equal(await allTitlesDone('denis', `Как «${POSTS}»?`), false)
  })

  test('подтверждение: сколько отправил и кому не писал', () => {
    const deadlineAt = new Date('2026-11-04T14:00:00Z')
    assert.equal(sentNote({ sent: 2, failed: 1, skipped: [], collect: true, deadlineAt }), 'Отправил 2, не дошло 1. Отчёт пришлю к 17:00')
    assert.equal(sentNote({ sent: 1, failed: 0, skipped: ['Денис, SMM'], collect: false, deadlineAt }), 'Отправил 1\nНе отправил Денис, SMM, задачи уже сделаны')
    assert.equal(sentNote({ sent: 0, failed: 0, skipped: ['Денис, SMM', 'Антон, SMM'], collect: true, deadlineAt }), 'Никому не отправил\nНе отправил Денис, SMM, задачи уже сделаны\nНе отправил Антон, SMM, задачи уже сделаны')
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
    patch(t, prisma.task, 'findMany', async ({ where }) => tasksByOwner[where.AND[1].ownerId.in[0]] ?? [])
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
    assert.match(note, /^Отправил 1\. Отчёт пришлю к \d\d:\d\d\nНе отправил Денис, SMM, задачи уже сделаны$/)
    assert.equal(run.closed.length, 0)
  })

  test('сделано у всех — никому не пишем, поручение закрыто без отчёта', async (t) => {
    const run = pressGo(t, {
      texts: { denis: `Денис, как «${POSTS}»?` },
      tasksByOwner: { denis: [task({ ownerId: 'denis', owner: denis, status: 'done' })] },
    })
    const note = await run.run()
    assert.equal(run.written.length, 0)
    assert.match(note, /^Никому не отправил\nНе отправил Денис, SMM, задачи уже сделаны$/)
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

describe('неполная проверка видна Яну', () => {
  test('упоминаний в кавычках больше предела — проверка неполная, а не «всё чисто»', async (t) => {
    patch(t, prisma.user, 'findMany', async () => [])
    patch(t, prisma.task, 'findMany', async () => [])
    const text = Array.from({ length: MENTIONS_MAX + 5 }, (_, i) => `«Задача ${i}»`).join(' ')
    assert.equal((await foreignTitles([{ userId: 'denis', text }], ADMIN)).incomplete, true)
    assert.equal((await foreignTitles([{ userId: 'denis', text: 'Как «Баннер»?' }], ADMIN)).incomplete, false)
  })

  test('в сообщении с кнопками пометка, что названия проверены не все', async () => {
    const { confirmText } = await import('../agent/rounds.js')
    const base = { topic: 'Как дела', collect: true, deadlineAt: new Date('2026-11-06T14:30:00Z'), count: 2, links: [] }
    assert.match(confirmText({ ...base, unchecked: true }), /проверил не все названия/)
    assert.doesNotMatch(confirmText(base), /проверил не все/)
  })
})
