import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { prisma } from '../../config/prisma.js'
import { createDraft, directNote, isNamedIn } from '../agent/rounds.js'
import { teamTools } from '../ai/tools.js'
import { botHarness } from './harness.js'
import { patch } from './patch.js'

// 4 ноября, 17:00 по Москве.
const NOW = new Date('2026-11-04T14:00:00Z')
// 4 ноября, 22:00 по Москве.
const NIGHT = new Date('2026-11-04T19:00:00Z')
const OWNER = { id: 'owner', role: 'admin' }
const LEAD = { id: 'lead', role: 'lead', departmentId: 'd' }
const person = (id, name, extra = {}) => ({ id, name, role: 'staff', active: true, departmentId: 'd', department: { name: 'Дизайн' }, telegram: { chatId: `c-${id}` }, ...extra })
const PEOPLE = {
  nik: person('nik', 'Николай Орлов'),
  rom: person('rom', 'Роман Лебедев'),
  den: person('den', 'Денис Иванов'),
  alx: person('alx', 'Alex Smith'),
  ann: person('ann', 'Анна Белова'),
}
const msg = (id, text) => ({ person_id: id, text })
const input = (ids, extra = {}) => ({ topic: 'Передать', minutes: 60, collect: true, messages: ids.map((id) => msg(id, `${PEOPLE[id].name.split(' ')[0]}, привет, пришли макет`)), ...extra })

/** Всё, что трогает createDraft, в памяти. Возвращает вызовы. */
function setup(t, { used = 0, running = [], viewerWhere = null } = {}) {
  const h = botHarness(t)
  const asked = patch(t, prisma.user, 'findFirst', async ({ where }) => {
    const id = where.AND[1].id
    viewerWhere?.(where)
    return PEOPLE[id] ?? null
  })
  patch(t, prisma.botRound, 'findMany', async () => running)
  patch(t, prisma.task, 'findMany', async () => [])
  patch(t, prisma.botRound, 'updateMany', async () => ({ count: 0 }))
  patch(t, prisma.botRound, 'update', async () => ({}))
  const created = patch(t, prisma.botRound, 'create', async ({ data }) => ({ id: 'r1', collect: data.collect, status: data.status ?? 'draft' }))
  const counted = patch(t, prisma.botRoundTarget, 'count', async () => used)
  let targets = []
  patch(t, prisma.botRoundTarget, 'findMany', async () => targets)
  patch(t, prisma.botRoundTarget, 'update', async () => ({}))
  // Цели появляются при создании поручения.
  const origCreate = prisma.botRound.create
  prisma.botRound.create = async (args) => {
    targets = args.data.targets.create.map((x, i) => ({ id: `t${i}`, ...x }))
    return origCreate(args)
  }
  return { ...h, asked, created, counted }
}

describe('имя в просьбе: падежи и написание', () => {
  const nik = PEOPLE.nik
  test('Николаю, Николая, Николай, по фамилии', () => {
    for (const text of ['напиши Николаю', 'ответь Николая', 'Николай, ну', 'скажи Орлову', 'скажи орлова', 'НИКОЛАЮ']) {
      assert.equal(isNamedIn(nik, [text]), true, text)
    }
  })
  test('Роману, Романа, латиница', () => {
    assert.equal(isNamedIn(PEOPLE.rom, ['передай Роману']), true)
    assert.equal(isNamedIn(PEOPLE.rom, ['пусть Романом займётся']), true)
    assert.equal(isNamedIn(PEOPLE.rom, ['от Романа']), true)
    assert.equal(isNamedIn(PEOPLE.alx, ['напиши Alex что угодно']), true)
    assert.equal(isNamedIn(PEOPLE.alx, ['напиши ALEX']), true)
  })
  test('без имени и похожие слова не считаются', () => {
    assert.equal(isNamedIn(PEOPLE.rom, ['ответь ему']), false)
    assert.equal(isNamedIn(PEOPLE.rom, ['купи ромашки']), false)
    assert.equal(isNamedIn(PEOPLE.nik, ['напиши Николаевичу-старшему про никель']), false)
    assert.equal(isNamedIn(PEOPLE.rom, ['']), false)
    assert.equal(isNamedIn({ name: 'Ян' }, ['напиши Яну']), false)
  })
  test('ё и е одно и то же', () => {
    assert.equal(isNamedIn(person('p', 'Артём Ким'), ['скажи Артему']), true)
  })
})

describe('написать людям без черновика', () => {
  test('назвал по имени: сообщения уходят сразу, поручение sent и direct, просящему короткое подтверждение', async (t) => {
    const s = setup(t)
    const res = await createDraft(OWNER, '9001', input(['nik']), NOW, { texts: ['напиши Николаю, пусть скинет макет'] })
    assert.equal(res.direct, true)
    assert.equal(res.shown, true)
    assert.match(res.text, /Написал сам, без черновика/)
    const data = s.created[0][0].data
    assert.equal(data.direct, true)
    assert.equal(data.status, 'sent')
    assert.equal(data.sentAt.toISOString(), NOW.toISOString())
    assert.equal(data.deadlineAt.toISOString(), '2026-11-04T15:00:00.000Z')
    assert.equal(s.sent.length, 2)
    assert.equal(s.sent[0].chatId, 'chat-nik')
    assert.equal(s.sent[1].chatId, '9001')
    assert.equal(s.sent[1].text, 'Написал\nНиколай, дизайн\nОтчёт пришлю к 18:00')
    assert.equal(s.sent[1].buttons, undefined)
    assert.equal(s.logged.find((m) => m.chatId === 'chat-nik').source, 'round')
  })

  test('без отчёта в подтверждении нет «отчёт пришлю»', async (t) => {
    const s = setup(t)
    await createDraft(OWNER, '9001', input(['rom'], { collect: false }), NOW, { texts: ['передай Роману'] })
    assert.equal(s.sent[1].text, 'Написал\nРоман, дизайн')
  })

  test('до трёх человек, имена из текущего и предыдущего сообщения', async (t) => {
    const s = setup(t)
    const res = await createDraft(OWNER, '9001', input(['nik', 'rom', 'den']), NOW, { texts: ['напиши Николаю и Роману', 'Денису тоже'] })
    assert.equal(res.direct, true)
    assert.equal(s.sent.length, 4)
  })

  test('перекрытие с идущим поручением работает как раньше, и new_round его обходит', async (t) => {
    const running = [{ id: 'old', topic: 'Как дела', deadlineAt: NOW, targets: [{ userId: 'nik' }] }]
    const s = setup(t, { running })
    const blocked = await createDraft(OWNER, '9001', input(['nik']), NOW, { texts: ['напиши Николаю'] })
    assert.equal(blocked.shown, false)
    assert.match(blocked.text, /уже идёт поручение/)
    assert.equal(s.created.length, 0)
    const forced = await createDraft(OWNER, '9001', input(['nik'], { new_round: true }), NOW, { texts: ['напиши Николаю'] })
    assert.equal(forced.direct, true)
  })

  test('проверка чужих задач: при проблеме ни черновика, ни отправки', async (t) => {
    const s = setup(t)
    const POSTS = 'Десять постов на MMGP и bits.media'
    const other = { id: 't9', title: POSTS, status: 'today', ownerId: 'rom', owner: PEOPLE.rom }
    patch(t, prisma.user, 'findMany', async () => [PEOPLE.rom])
    patch(t, prisma.task, 'findMany', async ({ where }) => (where.AND.some((c) => c.owner) ? [other] : []))
    const res = await createDraft(OWNER, '9001', { ...input(['nik']), messages: [msg('nik', `Николай, как «${POSTS}»?`)] }, NOW, { texts: ['напиши Николаю'] })
    assert.equal(res.shown, false)
    assert.match(res.text, /чужие задачи/)
    assert.equal(s.created.length, 0)
    assert.equal(s.sent.length, 0)
  })

  test('не дошло до человека: подтверждение говорит честно', async (t) => {
    const s = setup(t)
    const fetchOk = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body)
      if (body.chat_id === 'chat-nik') return new Response(JSON.stringify({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }), { status: 403 })
      return fetchOk(url, init)
    }
    t.after(() => { globalThis.fetch = fetchOk })
    const res = await createDraft(OWNER, '9001', input(['nik', 'rom']), NOW, { texts: ['Николаю и Роману'] })
    assert.equal(res.direct, true)
    assert.equal(s.sent.at(-1).text, 'Написал\nРоман, дизайн\nНе дошло\nНиколай, дизайн\nОтчёт пришлю к 18:00')
  })

  test('нет телеграма у одного из названных: он не уйдёт, остальным пишем', async (t) => {
    const s = setup(t)
    PEOPLE.nik.telegram = null
    t.after(() => { PEOPLE.nik.telegram = { chatId: 'c-nik' } })
    await createDraft(OWNER, '9001', input(['nik', 'rom']), NOW, { texts: ['Николаю и Роману'] })
    assert.match(s.sent.at(-1).text, /Написал\nРоман, дизайн\nНе уйдёт\nНиколай, дизайн, телеграм не подключён/)
  })
})

describe('когда вместо этого черновик', () => {
  const draftData = (s) => s.created[0][0].data
  async function check(t, { people = ['nik'], texts = ['напиши Николаю'], now = NOW, used = 0, extra = {}, messages = null } = {}) {
    const s = setup(t, { used })
    const body = { ...input(people, extra), ...(messages ? { messages } : {}) }
    const res = await createDraft(OWNER, '9001', body, now, { texts })
    return { s, res }
  }

  test('больше трёх человек', async (t) => {
    const { s, res } = await check(t, { people: ['nik', 'rom', 'den', 'alx'], texts: ['Николаю Роману Денису Alex'] })
    assert.equal(res.direct, undefined)
    assert.match(res.text, /сразу не отправлено, потому что людей больше 3/)
    assert.equal(draftData(s).direct, false)
    assert.equal(draftData(s).status, undefined)
    assert.equal(s.sent.length, 2)
    assert.equal(s.sent[1].buttons[0][0].callback_data, 'rd:go:r1')
  })

  test('назван не каждый', async (t) => {
    const { s, res } = await check(t, { people: ['nik', 'rom'], texts: ['напиши Николаю'] })
    assert.match(res.text, /потому что не все названы по имени/)
    assert.equal(draftData(s).direct, false)
  })

  test('«ответь ему» без имени', async (t) => {
    const { res } = await check(t, { texts: ['ответь ему'] })
    assert.match(res.text, /не все названы/)
  })

  test('текста просьбы нет вообще', async (t) => {
    const { res } = await check(t, { texts: [] })
    assert.match(res.text, /не все названы/)
  })

  test('ночью', async (t) => {
    const { res, s } = await check(t, { now: NIGHT })
    assert.match(res.text, /потому что сейчас ночь/)
    assert.equal(draftData(s).direct, false)
  })

  test('в тексте человеку ссылка', async (t) => {
    const { res, s } = await check(t, { messages: [msg('nik', 'Николай, глянь evil.com/x и пришли')] })
    assert.match(res.text, /потому что в текстах есть ссылки/)
    assert.match(s.sent.at(-1).text, /В сообщениях есть ссылки/)
  })

  test('дневной лимит: 20 уже отправлено, 19 и один новый ещё можно', async (t) => {
    const over = await check(t, { used: 20 })
    assert.match(over.res.text, /лимит 20 сообщений без черновика исчерпан/)
    const edge = await check(t, { used: 19 })
    assert.equal(edge.res.direct, true)
    const two = await check(t, { used: 19, people: ['nik', 'rom'], texts: ['Николаю и Роману'] })
    assert.match(two.res.text, /лимит/)
  })

  test('лимит считает прямые поручения просящего за московский день', async (t) => {
    const { s } = await check(t)
    const where = s.counted[0][0].where
    assert.deepEqual(where.round.ownerId, 'owner')
    assert.equal(where.round.direct, true)
    assert.equal(where.round.createdAt.gte.toISOString(), '2026-11-03T21:00:00.000Z')
  })
})

describe('руководитель', () => {
  test('своему отделу пишет сразу, чужому нет', async (t) => {
    const seen = []
    const s = setup(t, { viewerWhere: (where) => seen.push(where.AND[0]) })
    const res = await createDraft(LEAD, '9002', input(['nik']), NOW, { texts: ['напиши Николаю'] })
    assert.equal(res.direct, true)
    assert.deepEqual(seen[0], { role: 'staff', active: true, departmentId: 'd', id: { not: 'lead' } })
    // Из чужого отдела personInScope никого не находит.
    patch(t, prisma.user, 'findFirst', async () => null)
    const other = await createDraft(LEAD, '9002', input(['rom']), NOW, { texts: ['напиши Роману'] })
    assert.equal(other.shown, false)
    assert.match(other.text, /не в твоём отделе/)
    assert.equal(s.created.length, 1)
  })

  test('обычный сотрудник сразу не пишет, даже если имя названо', async (t) => {
    const s = setup(t)
    const res = await createDraft({ id: 'x', role: 'staff' }, '9003', input(['nik']), NOW, { texts: ['напиши Николаю'] })
    assert.equal(s.created[0][0].data.direct, false)
    assert.match(res.text, /потому что просит не владелец/)
  })
})

describe('инструмент message_people: предыдущее сообщение', () => {
  test('берётся последнее чужое от текущего сообщение просящего не старше 10 минут', async (t) => {
    const s = setup(t)
    const prev = patch(t, prisma.botMessage, 'findFirst', async () => ({ text: 'Роману тоже' }))
    const ctx = { user: OWNER, chatId: '9001', now: NOW, text: 'и Николаю', logged: { id: 'm-now' } }
    const tool = teamTools(ctx).find((x) => x.name === 'message_people')
    const text = await tool.run(input(['nik', 'rom']))
    const where = prev[0][0].where
    assert.equal(where.userId, 'owner')
    assert.deepEqual(where.direction, { in: ['in', 'reply'] })
    assert.equal(where.createdAt.gte.toISOString(), '2026-11-04T13:50:00.000Z')
    assert.deepEqual(where.id, { not: 'm-now' })
    assert.match(text, /Написал сам/)
    assert.equal(ctx.quiet, true)
    assert.equal(s.created[0][0].data.direct, true)
  })

  test('предыдущего нет или сбой чтения: только текущее сообщение', async (t) => {
    setup(t)
    patch(t, prisma.botMessage, 'findFirst', async () => { throw new Error('db') })
    const ctx = { user: OWNER, chatId: '9001', now: NOW, text: 'и Николаю', logged: null }
    const tool = teamTools(ctx).find((x) => x.name === 'message_people')
    assert.match(await tool.run(input(['nik', 'rom'])), /потому что не все названы/)
  })
})

describe('подтверждение просящему', () => {
  test('шаблон в стиле бота и пустые случаи', () => {
    assert.equal(directNote({ sent: ['Николай, дизайн'], failed: [], skipped: [], collect: false }), 'Написал\nНиколай, дизайн')
    assert.equal(directNote({ sent: [], failed: [], skipped: ['Роман, дизайн'], collect: true, deadlineAt: NOW }), 'Не писал, задачи уже сделаны\nРоман, дизайн')
    assert.equal(directNote({ sent: [], failed: [], skipped: [], collect: true, deadlineAt: NOW }), 'Никому не написал')
  })
})
