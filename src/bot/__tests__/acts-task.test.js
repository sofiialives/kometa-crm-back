import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { prisma } from '../../config/prisma.js'
import { ApiError } from '../../utils/ApiError.js'
import { assigneeText, decideOffer, defaultDeadline, dueText, offerText, parseMsk, proposeTask } from '../agent/offers.js'
import { onCallback } from '../agent/router.js'
import { teamTools } from '../ai/tools.js'
import { worksBrief } from '../ai/context.js'
import { botHarness } from './harness.js'
import { patch } from './patch.js'

// 4 ноября, 17:00 по Москве.
const NOW = new Date('2026-11-04T14:00:00Z')
const ADMIN = { id: 'owner', name: 'Ян', role: 'admin', active: true, departmentId: null, department: null }
const LEAD = { id: 'lead', name: 'Мария Попова', role: 'lead', active: true, departmentId: 'd', department: { name: 'Дизайн' } }
const IVAN = { id: 'ivan', name: 'Иван Петров', role: 'staff', active: true, departmentId: 'd', department: { name: 'Дизайн' }, telegram: { chatId: 'c-ivan' } }
const WORK = { id: 'w1', title: 'Лендинг', status: 'active', client: { name: 'Румикс' } }
const iso = (d) => new Date(d).toISOString()

const base = (extra = {}) => ({ person_id: 'ivan', title: 'Сделать баннер', description: null, deadline: '2026-11-05T12:00', start_at: null, work_id: null, note: null, ...extra })

/** База в памяти: люди, работа, карточки. */
function memory(t, { users = { owner: ADMIN, lead: LEAD, ivan: IVAN }, work = WORK, scope = IVAN, offers = [], today = 0, hanging = 0 } = {}) {
  const h = botHarness(t)
  const store = new Map(offers.map((o) => [o.id, o]))
  patch(t, prisma.user, 'findFirst', async () => scope)
  patch(t, prisma.user, 'findUnique', async ({ where }) => users[where.id] ?? null)
  patch(t, prisma.work, 'findUnique', async () => work)
  const counts = []
  patch(t, prisma.botTaskOffer, 'count', async ({ where }) => { counts.push(where); return where.status === 'draft' ? hanging : today })
  patch(t, prisma.botTaskOffer, 'create', async ({ data }) => {
    const row = { id: 'o1', status: 'draft', createdAt: NOW, ...data }
    store.set(row.id, row)
    return row
  })
  patch(t, prisma.botTaskOffer, 'findUnique', async ({ where }) => store.get(where.id) ?? null)
  patch(t, prisma.botTaskOffer, 'updateMany', async ({ where, data }) => {
    const row = store.get(where.id)
    if (!row || (where.status && row.status !== where.status)) return { count: 0 }
    Object.assign(row, data)
    return { count: 1 }
  })
  patch(t, prisma.botTaskOffer, 'update', async ({ where, data }) => Object.assign(store.get(where.id), data))
  return { ...h, store, counts }
}

const offerRow = (extra = {}) => ({ id: 'o1', requesterId: 'owner', assigneeId: 'ivan', title: 'Сделать баннер', description: null, deadline: new Date('2026-11-04T16:00:00Z'), startAt: null, workId: null, note: null, status: 'draft', taskId: null, createdAt: NOW, ...extra })
const created = (extra = {}) => async () => [{ id: 't1', ...extra }]

describe('срок по умолчанию и разбор времени', () => {
  test('до 18:00 сегодня до 19:00, с 18:00 завтра до 19:00 (по Москве)', () => {
    assert.equal(iso(defaultDeadline(new Date('2026-11-04T14:00:00Z'))), '2026-11-04T16:00:00.000Z')
    assert.equal(iso(defaultDeadline(new Date('2026-11-04T14:59:00Z'))), '2026-11-04T16:00:00.000Z')
    assert.equal(iso(defaultDeadline(new Date('2026-11-04T15:00:00Z'))), '2026-11-05T16:00:00.000Z')
    assert.equal(iso(defaultDeadline(new Date('2026-11-04T20:30:00Z'))), '2026-11-05T16:00:00.000Z')
    // 01:00 ночи по Москве уже новый день.
    assert.equal(iso(defaultDeadline(new Date('2026-11-04T22:00:00Z'))), '2026-11-05T16:00:00.000Z')
    // Пятница вечером: выходные не учитываем, просто следующий день.
    assert.equal(iso(defaultDeadline(new Date('2026-11-06T16:00:00Z'))), '2026-11-07T16:00:00.000Z')
  })
  test('ISO без пояса это Москва, с поясом как есть, только дата 19:00', () => {
    assert.equal(iso(parseMsk('2026-11-05T12:00')), '2026-11-05T09:00:00.000Z')
    assert.equal(iso(parseMsk('2026-11-05 12:00:30')), '2026-11-05T09:00:00.000Z')
    assert.equal(iso(parseMsk('2026-11-05T12:00:00Z')), '2026-11-05T12:00:00.000Z')
    assert.equal(iso(parseMsk('2026-11-05T12:00:00+0500')), '2026-11-05T07:00:00.000Z')
    assert.equal(iso(parseMsk('2026-11-05')), '2026-11-05T16:00:00.000Z')
    assert.equal(parseMsk('завтра'), undefined)
    assert.equal(parseMsk('2026-13-45T10:00'), undefined)
    assert.equal(parseMsk(''), undefined)
  })
  test('срок словами', () => {
    assert.equal(dueText(new Date('2026-11-04T16:00:00Z'), NOW), 'сегодня до 19:00')
    assert.equal(dueText(new Date('2026-11-04T16:00:00Z'), NOW, { on: true }), 'на сегодня до 19:00')
    assert.equal(dueText(new Date('2026-11-05T09:00:00Z'), NOW, { on: true }), 'на завтра до 12:00')
    assert.equal(dueText(new Date('2026-11-20T09:00:00Z'), NOW, { on: true }), '20 ноября до 12:00')
  })
})

describe('карточка: assign_task', () => {
  test('личная задача: карточка с кнопками, в базе черновик, ничего в CRM не создано', async (t) => {
    const m = memory(t)
    const res = await proposeTask(ADMIN, '9001', base({ description: 'Размер 1080', note: 'Иван, посмотри бриф' }), NOW)
    assert.equal(res.shown, true)
    assert.match(res.text, /задача пока не создана/)
    const row = m.store.get('o1')
    assert.equal(row.status, 'draft')
    assert.equal(row.requesterId, 'owner')
    assert.equal(row.assigneeId, 'ivan')
    assert.equal(row.workId, null)
    assert.equal(iso(row.deadline), '2026-11-05T09:00:00.000Z')
    assert.equal(m.sent.length, 1)
    assert.equal(m.sent[0].chatId, '9001')
    assert.equal(m.sent[0].text, '<b>Поставить задачу</b>\n<b>Иван, дизайн</b>\n«Сделать баннер»\nСрок завтра до 12:00\nЛичная задача на день\nОписание Размер 1080\nНапишу ему Иван, посмотри бриф\nПоставить?')
    assert.deepEqual(m.sent[0].buttons[0].map((b) => b.callback_data), ['ta:go:o1', 'ta:no:o1'])
    assert.deepEqual(m.sent[0].buttons[0].map((b) => b.text), ['Поставить', 'Отмена'])
  })

  test('по работе: в карточке клиент и работа', async (t) => {
    const m = memory(t)
    await proposeTask(LEAD, '9002', base({ work_id: 'w1' }), NOW)
    assert.equal(m.store.get('o1').workId, 'w1')
    assert.match(m.sent[0].text, /По работе, клиент Румикс, Лендинг/)
  })

  test('срок не назван: сегодня до 19:00, после 18:00 завтра', async (t) => {
    const m = memory(t)
    await proposeTask(ADMIN, '9001', base({ deadline: null }), NOW)
    assert.equal(iso(m.store.get('o1').deadline), '2026-11-04T16:00:00.000Z')
    assert.match(m.sent[0].text, /Срок сегодня до 19:00/)
    await proposeTask(ADMIN, '9001', base({ deadline: null }), new Date('2026-11-04T15:30:00Z'))
    assert.equal(iso(m.store.get('o1').deadline), '2026-11-05T16:00:00.000Z')
  })

  test('срок в прошлом или непонятный: отказ, ничего не создано', async (t) => {
    const m = memory(t)
    const past = await proposeTask(ADMIN, '9001', base({ deadline: '2026-11-04T10:00' }), NOW)
    assert.equal(past.shown, false)
    assert.match(past.text, /Срок уже в прошлом.*уточнить срок/)
    const junk = await proposeTask(ADMIN, '9001', base({ deadline: 'завтра в обед' }), NOW)
    assert.match(junk.text, /Срок не разобрал/)
    const far = await proposeTask(ADMIN, '9001', base({ deadline: '2029-01-01T10:00' }), NOW)
    assert.match(far.text, /дальше года/)
    assert.equal(m.store.size, 0)
    assert.equal(m.sent.length, 0)
  })

  test('права: сотрудник не может, чужой отдел и несуществующий человек не находятся', async (t) => {
    const m = memory(t)
    const staff = await proposeTask({ id: 'x', role: 'staff' }, '9003', base(), NOW)
    assert.match(staff.text, /только Ян и руководитель/)
    const m2 = memory(t, { scope: null })
    const none = await proposeTask(LEAD, '9002', base(), NOW)
    assert.match(none.text, /нет или он не в твоём отделе/)
    assert.equal(m.store.size + m2.store.size, 0)
  })

  test('работа: нет такой или не активна', async (t) => {
    memory(t, { work: null })
    assert.match((await proposeTask(ADMIN, '9001', base({ work_id: 'nope' }), NOW)).text, /Такой работы нет/)
    memory(t, { work: { ...WORK, status: 'closed' } })
    assert.match((await proposeTask(ADMIN, '9001', base({ work_id: 'w1' }), NOW)).text, /не активна/)
  })

  test('пустое название и слишком длинное', async (t) => {
    const m = memory(t)
    assert.match((await proposeTask(ADMIN, '9001', base({ title: '  ' }), NOW)).text, /Нет названия/)
    await proposeTask(ADMIN, '9001', base({ title: 'я'.repeat(300) }), NOW)
    assert.equal(m.store.get('o1').title.length, 200)
  })

  test('слова агента исполнителю в стиле бота и без ссылок', async (t) => {
    const m = memory(t)
    await proposeTask(ADMIN, '9001', base({ note: 'Привет! Бриф тут https://evil.com/x (срочно):)' }), NOW)
    const note = m.store.get('o1').note
    assert.doesNotMatch(note, /evil|!|\(|http/)
    assert.match(note, /ссылка/)
  })

  test('лимиты: 30 предложений в день и 3 висящих', async (t) => {
    const m = memory(t, { today: 30 })
    assert.match((await proposeTask(ADMIN, '9001', base(), NOW)).text, /лимит 30 предложений/)
    assert.equal(m.store.size, 0)
    memory(t, { hanging: 3 })
    assert.match((await proposeTask(ADMIN, '9001', base(), NOW)).text, /Уже висит 3 карточек/)
    const ok = memory(t, { today: 29, hanging: 2 })
    assert.equal((await proposeTask(ADMIN, '9001', base(), NOW)).shown, true)
    // Висящие считаются только свежие, за три часа.
    const hangingWhere = ok.counts.find((w) => w.status === 'draft')
    assert.equal(hangingWhere.createdAt.gt.toISOString(), '2026-11-04T11:00:00.000Z')
    assert.equal(ok.counts.find((w) => !w.status).createdAt.gte.toISOString(), '2026-11-03T21:00:00.000Z')
  })

  test('сбой телеграма: карточка отменена, модели честно', async (t) => {
    const m = memory(t)
    const real = globalThis.fetch
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, error_code: 400, description: 'bad' }), { status: 400 })
    t.after(() => { globalThis.fetch = real })
    const res = await proposeTask(ADMIN, '9001', base(), NOW)
    assert.equal(res.shown, false)
    assert.equal(m.store.get('o1').status, 'cancelled')
  })

  test('инструмент есть у руководителя и владельца, quiet после карточки', async (t) => {
    memory(t)
    const ctx = { user: ADMIN, chatId: '9001', now: NOW, text: 'поставь Ивану баннер' }
    const tool = teamTools(ctx).find((x) => x.name === 'assign_task')
    assert.ok(tool)
    assert.deepEqual(tool.input_schema.required, ['person_id', 'title', 'description', 'deadline', 'start_at', 'work_id', 'note'])
    assert.match(await tool.run(base()), /Показана карточка/)
    assert.equal(ctx.quiet, true)
  })

  test('в сводке по работам виден id работы', async (t) => {
    patch(t, prisma.work, 'findMany', async () => [{ id: 'w-77', title: 'Лендинг', client: { name: 'Румикс' }, department: { name: 'Дизайн' }, assignees: [] }])
    patch(t, prisma.work, 'count', async () => 1)
    patch(t, prisma.task, 'groupBy', async () => [])
    assert.match(await worksBrief({ role: 'admin' }, null, NOW), /клиент Румикс, «Лендинг», id w-77, отдел Дизайн/)
  })
})

describe('кнопка «Поставить»', () => {
  const press = (user, go, extra = {}, now = NOW) => decideOffer(user, 'o1', go, now, extra)

  test('ставит задачу от имени просящего и пишет исполнителю', async (t) => {
    const m = memory(t, { offers: [offerRow({ note: 'Бриф в папке' })] })
    const calls = []
    const note = await decideOffer(ADMIN, 'o1', true, NOW, { create: async (a) => { calls.push(a); return [{ id: 't1' }] } })
    assert.equal(note, 'Поставил\nИван, дизайн')
    assert.deepEqual(calls[0].ownerIds, ['ivan'])
    assert.equal(calls[0].user.id, 'owner')
    assert.equal(calls[0].title, 'Сделать баннер')
    assert.equal(calls[0].workId, null)
    assert.equal(m.store.get('o1').status, 'created')
    assert.equal(m.store.get('o1').taskId, 't1')
    // Исполнителю: сегодня и личная, поэтому есть «Беру в работу».
    assert.equal(m.sent.length, 1)
    assert.equal(m.sent[0].chatId, 'chat-ivan')
    assert.equal(m.sent[0].text, 'Новая задача от Яна\n«Сделать баннер»\nСрок на сегодня до 19:00\nБриф в папке')
    assert.deepEqual(m.sent[0].buttons, [[{ text: 'Беру в работу', callback_data: 'tk:go:t1' }]])
    assert.equal(m.logged[0].source, 'notice')
  })

  test('от руководителя по работе: клиент и работа, без кнопки', async (t) => {
    const m = memory(t, { offers: [offerRow({ requesterId: 'lead', workId: 'w1', deadline: new Date('2026-11-05T09:00:00Z') })] })
    const note = await decideOffer(LEAD, 'o1', true, NOW, { create: created() })
    assert.equal(note, 'Поставил\nИван, дизайн')
    assert.equal(m.sent[0].text, 'Новая задача от руководителя Мария, дизайн\n«Сделать баннер»\nСрок на завтра до 12:00\nКлиент Румикс, работа Лендинг')
    assert.equal(m.sent[0].buttons, undefined)
  })

  test('двойное нажатие создаёт одну задачу', async (t) => {
    const m = memory(t, { offers: [offerRow()] })
    let n = 0
    const create = async () => { n += 1; await new Promise((r) => setTimeout(r, 5)); return [{ id: 't1' }] }
    const [a, b] = await Promise.all([decideOffer(ADMIN, 'o1', true, NOW, { create }), decideOffer(ADMIN, 'o1', true, NOW, { create })])
    assert.equal(n, 1)
    assert.deepEqual([a, b].sort(), ['Поставил\nИван, дизайн', 'Уже обработано'].sort())
    assert.equal(await decideOffer(ADMIN, 'o1', true, NOW, { create }), 'Уже поставлено')
    assert.equal(n, 1)
    assert.equal(m.sent.length, 1)
  })

  test('чужое нажатие и несуществующая карточка', async (t) => {
    const m = memory(t, { offers: [offerRow()] })
    let n = 0
    const create = async () => { n += 1; return [{ id: 't1' }] }
    assert.equal(await decideOffer(LEAD, 'o1', true, NOW, { create }), 'Это не твоя карточка')
    assert.equal(await decideOffer(IVAN, 'o1', true, NOW, { create }), 'Это не твоя карточка')
    assert.equal(await decideOffer(ADMIN, 'nope', true, NOW, { create }), 'Это не твоя карточка')
    assert.equal(n, 0)
    assert.equal(m.store.get('o1').status, 'draft')
  })

  test('устаревшая карточка (3 часа) задачу не ставит', async (t) => {
    const m = memory(t, { offers: [offerRow()] })
    let n = 0
    const later = new Date(NOW.getTime() + 3 * 3600000 + 60000)
    assert.equal(await decideOffer(ADMIN, 'o1', true, later, { create: async () => { n += 1; return [{ id: 't' }] } }), 'Карточка устарела, попроси ещё раз')
    assert.equal(n, 0)
    assert.equal(m.store.get('o1').status, 'cancelled')
    assert.equal(await decideOffer(ADMIN, 'o1', true, NOW, {}), 'Уже отменено')
  })

  test('отмена', async (t) => {
    const m = memory(t, { offers: [offerRow()] })
    assert.equal(await decideOffer(ADMIN, 'o1', false, NOW), 'Отменено, задачу не ставил')
    assert.equal(m.store.get('o1').status, 'cancelled')
    assert.equal(m.sent.length, 0)
  })

  test('права читаются заново: лид стал сотрудником или отключён', async (t) => {
    const m = memory(t, { users: { lead: { ...LEAD, role: 'staff' }, ivan: IVAN }, offers: [offerRow({ requesterId: 'lead' })] })
    let n = 0
    assert.equal(await decideOffer(LEAD, 'o1', true, NOW, { create: async () => { n += 1; return [{ id: 't' }] } }), 'Не поставил, у тебя больше нет прав ставить задачи')
    assert.equal(n, 0)
    assert.equal(m.store.get('o1').status, 'cancelled')
  })

  test('настоящий createTask: руководитель не ставит задачу человеку из другого отдела', async (t) => {
    const m = memory(t, { users: { lead: LEAD, ivan: { ...IVAN, departmentId: 'other' } }, offers: [offerRow({ requesterId: 'lead' })] })
    const note = await decideOffer(LEAD, 'o1', true, NOW)
    assert.equal(note, 'Не поставил\nМожно назначать задачи только сотрудникам своего отдела')
    assert.equal(m.store.get('o1').status, 'cancelled')
    assert.equal(m.sent.length, 0)
  })

  test('настоящий createTask: сотрудник по работе и админ себе по работе', async (t) => {
    const m = memory(t, { users: { owner: { ...ADMIN, role: 'staff' } }, offers: [offerRow({ workId: 'w1' })] })
    // Права просящего уже не те — отказ до createTask.
    assert.match(await decideOffer(ADMIN, 'o1', true, NOW), /нет прав/)
    memory(t, { users: { owner: ADMIN, ivan: IVAN }, offers: [offerRow({ workId: 'w1', assigneeId: 'owner' })] })
    assert.equal(await decideOffer(ADMIN, 'o1', true, NOW), 'Не поставил\nАдмин не может назначить задачу по работе на себя, выберите сотрудника')
    assert.equal(m.sent.length, 0)
  })

  test('лимит личных задач из createTask превращается в короткую фразу', async (t) => {
    const m = memory(t, { offers: [offerRow()] })
    const create = async () => { throw ApiError.badRequest('Личных задач на сегодня уже 7 из 7, больше поставить нельзя. Объедините мелкие в одну и опишите подробнее') }
    assert.equal(await decideOffer(ADMIN, 'o1', true, NOW, { create }), 'Не поставил\nЛичных задач на сегодня уже 7 из 7, больше поставить нельзя. Объедините мелкие в одну и опишите подробнее')
    assert.equal(m.store.get('o1').status, 'cancelled')
    assert.equal(m.sent.length, 0)
  })

  test('неожиданная ошибка не раскрывается', async (t) => {
    memory(t, { offers: [offerRow()] })
    const create = async () => { throw new Error('connect ECONNREFUSED secret-host') }
    const note = await decideOffer(ADMIN, 'o1', true, NOW, { create })
    assert.equal(note, 'Не поставил\nне получилось, открой CRM')
  })

  test('работа закрылась, пока висела карточка', async (t) => {
    const m = memory(t, { work: { ...WORK, status: 'closed' }, offers: [offerRow({ workId: 'w1' })] })
    let n = 0
    assert.equal(await decideOffer(ADMIN, 'o1', true, NOW, { create: async () => { n += 1; return [{ id: 't' }] } }), 'Не поставил\nРабота уже не активна')
    assert.equal(n, 0)
    assert.equal(m.store.get('o1').status, 'cancelled')
  })

  test('нет телеграма у исполнителя: задача создана, просящему так и сказано', async (t) => {
    const m = memory(t, { offers: [offerRow()] })
    patch(t, prisma.telegramLink, 'findFirst', async () => null)
    let n = 0
    const note = await decideOffer(ADMIN, 'o1', true, NOW, { create: async () => { n += 1; return [{ id: 't1' }] } })
    assert.equal(note, 'Поставил\nИван, дизайн\nТелеграм не подключён, задача в CRM')
    assert.equal(n, 1)
    assert.equal(m.sent.length, 0)
    assert.equal(m.store.get('o1').status, 'created')
  })

  test('исполнитель заблокировал бота: задача создана, сообщение не дошло', async (t) => {
    memory(t, { offers: [offerRow()] })
    const real = globalThis.fetch
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }), { status: 403 })
    t.after(() => { globalThis.fetch = real })
    const note = await decideOffer(ADMIN, 'o1', true, NOW, { create: created() })
    assert.equal(note, 'Поставил\nИван, дизайн\nСообщение не дошло, задача в CRM')
  })
})

describe('нажатие кнопки в роутере', () => {
  test('ta:go и ta:no ведут в решение, под карточкой остаётся пометка', async (t) => {
    const m = memory(t, { offers: [offerRow()] })
    patch(t, prisma.botMessage, 'count', async () => 0)
    const cb = (data) => ({ id: 'cb', data, message: { chat: { id: '9001' }, message_id: 5, text: 'Поставить задачу', reply_markup: { inline_keyboard: [[{ text: 'Поставить', callback_data: data }]] } } })
    await onCallback(cb('ta:no:o1'), ADMIN, NOW)
    assert.equal(m.store.get('o1').status, 'cancelled')
    assert.match(m.edits.at(-1).text, /Отменено, задачу не ставил/)
    // Чужой человек получает отказ, а не молчание.
    await onCallback(cb('ta:go:o1'), IVAN, NOW)
    assert.match(m.edits.at(-1).text, /Это не твоя карточка/)
  })
})

describe('тексты по стилю бота', () => {
  const assignee = IVAN
  test('карточка и сообщение исполнителю без точки, скобок, двоеточий и тире', () => {
    const card = offerText({ assignee, title: 'Баннер', description: 'Размер 1080', deadline: new Date('2026-11-05T09:00:00Z'), work: WORK, note: 'Бриф в папке', now: NOW })
    const msg = assigneeText({ requester: LEAD, title: 'Баннер', deadline: new Date('2026-11-04T16:00:00Z'), work: WORK, note: 'Бриф в папке', now: NOW })
    for (const text of [card, msg]) {
      const clean = text.replace(/<[^>]+>/g, '')
      assert.doesNotMatch(clean, /[()!•—–]|\p{Extended_Pictographic}/u)
      assert.doesNotMatch(clean, /(^|[^\d]):|:(?!\d)/)
      assert.doesNotMatch(clean, /(?<!\.)\.[ \t]*$/m)
    }
  })
  test('название с html экранируется', () => {
    assert.match(assigneeText({ requester: ADMIN, title: '<b>x</b>', deadline: NOW, now: NOW }), /&lt;b&gt;x&lt;\/b&gt;/)
  })
})
