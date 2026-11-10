import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { prisma } from '../../config/prisma.js'
import { env } from '../../config/env.js'
import { morningLines, morningText } from '../ai/morning.js'
import { roundSection } from '../ai/system.js'
import { aiLimit } from '../ai/limits.js'
import { morningReportText, morningTemplate, offerFor, offerState, personTemplate, runMorningRound, sendMorningReport, tickMorning } from '../agent/morning.js'
import { activeTarget } from '../agent/rounds.js'
import { botHarness } from './harness.js'
import { patch } from './patch.js'

// Вторник, 9:40 по Москве.
const NOW = new Date('2026-11-03T06:40:00Z')
const REPORT_AT = new Date('2026-11-03T07:10:00Z')
const SATURDAY = new Date('2026-11-07T06:40:00Z')

const dept = { name: 'Дизайн' }
const roman = { id: 'roman', name: 'Роман Котов', role: 'staff', active: true, departmentId: 'd1', department: dept, chat: true }
const nina = { id: 'nina', name: 'Нина Орлова', role: 'lead', active: true, departmentId: 'd1', department: dept, chat: true }
const oleg = { id: 'oleg', name: 'Олег Ким', role: 'staff', active: true, departmentId: 'd2', department: { name: 'SEO' }, chat: true }
const yan = { id: 'yan', name: 'Ян', role: 'admin', active: true, departmentId: null, department: null, chat: true }

/**
 * Маленькая «база» в памяти: люди, задачи, отлучки и обход. Фильтры по роли,
 * активности и телеграму применяются по настоящему условию запроса, поэтому
 * тест ловит и забытого admin, и человека без бота.
 */
function world(t, { users = [roman, nina, oleg, yan], overdue = {}, hier = {}, counts = {}, away = {}, ended = [], tasks = [], asks = {} } = {}) {
  const h = botHarness(t)
  // Настоящая модель и её счётчики в тестах не нужны: без ключа ИИ выключен.
  const key = env.anthropicApiKey
  env.anthropicApiKey = ''
  t.after(() => { env.anthropicApiKey = key })
  for (const id of ended) h.notices.add(`dayend:2026-11-03:${id}`)
  // Чат есть не у всех: у человека без телеграма chatOf отдаёт null.
  patch(t, prisma.telegramLink, 'findFirst', async ({ where }) => {
    const u = users.find((x) => x.id === where.userId)
    return u?.chat ? { chatId: `chat-${u.id}` } : null
  })
  const pick = (u) => ({ id: u.id, name: u.name, role: u.role, departmentId: u.departmentId, department: u.department, telegram: u.chat ? { chatId: `chat-${u.id}` } : null })
  patch(t, prisma.user, 'findMany', async ({ where }) => {
    const roles = where.role?.in ?? [where.role]
    return users.filter((u) => roles.includes(u.role) && (where.active === undefined || u.active === where.active) && (!where.telegram || u.chat)).map(pick)
  })
  const db = { rounds: [], targets: [], tasks, offered: [], updates: [] }
  patch(t, prisma.motivationAway, 'findFirst', async ({ where }) => away[where.userId] ?? null)
  patch(t, prisma.task, 'findFirst', async ({ where }) => {
    const w = where.AND[1]
    return w.origin === 'hierarchy' ? hier[w.ownerId] ?? null : overdue[w.ownerId] ?? null
  })
  patch(t, prisma.task, 'count', async ({ where }) => {
    const w = where.AND[1]
    // «Поставил после сообщения»: задачи этого человека не раньше его сообщения.
    if (w.createdAt) return db.tasks.filter((x) => x.ownerId === w.ownerId && x.createdAt >= w.createdAt.gte).length
    const c = counts[w.ownerId] ?? {}
    if (w.origin === 'hierarchy') return c.hierarchy ?? 0
    return where.AND[2] ? c.overdue ?? 0 : c.today ?? 0
  })
  patch(t, prisma.task, 'findMany', async ({ where, take }) => {
    const w = where.AND[1]
    if (w.id) return db.offered.filter((x) => w.id.in.includes(x.id) && w.ownerId.in.includes(x.ownerId))
    return db.tasks.filter((x) => x.ownerId === w.ownerId).slice(0, take)
  })
  patch(t, prisma.task, 'groupBy', async ({ where }) => {
    const w = where.AND[1]
    const since = where.AND[2]?.createdAt?.gte
    const counts = new Map()
    for (const x of db.tasks) {
      if (!w.ownerId.in.includes(x.ownerId) || (since && x.createdAt < since)) continue
      counts.set(x.ownerId, (counts.get(x.ownerId) ?? 0) + 1)
    }
    return [...counts].map(([ownerId, _count]) => ({ ownerId, _count }))
  })
  patch(t, prisma.botRound, 'findFirst', async () => db.rounds.find((r) => r.kind === 'morning') ?? null)
  patch(t, prisma.botRound, 'create', async ({ data }) => {
    const r = { id: `r${db.rounds.length + 1}`, reportTries: 0, createdAt: NOW, ...data }
    db.rounds.push(r)
    return r
  })
  patch(t, prisma.botRound, 'findUnique', async ({ where }) => {
    const r = db.rounds.find((x) => x.id === where.id)
    return r ? { ...r, owner: users.find((u) => u.id === r.ownerId) } : null
  })
  patch(t, prisma.botRound, 'updateMany', async ({ where, data }) => {
    const r = db.rounds.find((x) => x.id === where.id && x.status === where.status)
    if (!r) return { count: 0 }
    Object.assign(r, data)
    return { count: 1 }
  })
  patch(t, prisma.botRound, 'update', async ({ where, data }) => {
    const r = db.rounds.find((x) => x.id === where.id)
    const { reportTries, ...rest } = data
    Object.assign(r, rest)
    if (reportTries) r.reportTries += 1
    return r
  })
  patch(t, prisma.botRound, 'findMany', async ({ where }) => db.rounds.filter((r) => r.kind === where.kind && r.status === where.status && r.deadlineAt <= where.deadlineAt.lte))
  // Опрос Яна, который уже идёт с человеком: asks[userId].
  patch(t, prisma.botRoundTarget, 'findFirst', async ({ where }) => (where.round?.kind
    ? asks[where.userId] ?? null
    : db.targets.find((x) => x.roundId === where.roundId && x.userId === where.userId) ?? null))
  // Сообщения людей мимо обхода: ответ на опрос Яна, чек-ин, команда.
  db.own = []
  patch(t, prisma.botMessage, 'findMany', async ({ where }) => db.own.filter((m) => where.userId.in.includes(m.userId) && where.direction.in.includes(m.direction) && m.createdAt >= where.createdAt.gte))
  patch(t, prisma.botRoundTarget, 'create', async ({ data }) => {
    const x = { id: `t${db.targets.length + 1}`, status: 'pending', summary: null, messages: [], sentAt: null, ...data }
    db.targets.push(x)
    return x
  })
  patch(t, prisma.botRoundTarget, 'update', async ({ where, data }) => {
    const x = db.targets.find((y) => y.id === where.id)
    Object.assign(x, data)
    return x
  })
  patch(t, prisma.botRoundTarget, 'findMany', async ({ where }) => db.targets
    .filter((x) => x.roundId === where.roundId && where.status.in.includes(x.status))
    .map((x) => ({ ...x, user: users.find((u) => u.id === x.userId) })))
  // Ни событий, ни баллов: любое обращение к ним — ошибка теста.
  const penalties = []
  for (const name of ['botEvent', 'motivationEvent', 'motivationReview']) {
    if (!prisma[name]) continue
    for (const method of ['create', 'createMany', 'update', 'upsert']) patch(t, prisma[name], method, async () => { penalties.push(`${name}.${method}`); return {} })
  }
  return { h, db, penalties }
}

const ask = (text = null) => async () => text
const toUser = (h, id) => h.sent.filter((m) => m.chatId === `chat-${id}`)

describe('кому утренний обход пишет', () => {
  test('сотрудникам и руководителям, Яну нет', async (t) => {
    const { h, db } = world(t)
    const sent = await runMorningRound(NOW, { ask: ask('Роман, доброе утро') })
    assert.equal(sent, 3)
    assert.deepEqual(['roman', 'nina', 'oleg'].map((id) => toUser(h, id).length), [1, 1, 1])
    assert.equal(toUser(h, 'yan').length, 0)
    // Одно поручение за день: kind morning, сбор, не прямая отправка, срок 10:10.
    assert.equal(db.rounds.length, 1)
    assert.deepEqual([db.rounds[0].kind, db.rounds[0].collect, db.rounds[0].direct ?? false, db.rounds[0].status], ['morning', true, false, 'sent'])
    assert.equal(db.rounds[0].deadlineAt.toISOString(), '2026-11-03T07:10:00.000Z')
    assert.equal(db.rounds[0].ownerId, 'yan')
    assert.ok(db.targets.every((x) => x.status === 'sent'))
  })

  test('без телеграма, неактивному и отошедшему не пишет; форс-мажор и конец дня тоже', async (t) => {
    const noChat = { ...roman, id: 'nochat', chat: false }
    const fired = { ...roman, id: 'fired', active: false }
    const brk = { ...roman, id: 'brk' }
    const fm = { ...roman, id: 'fm' }
    const home = { ...roman, id: 'home' }
    const { h } = world(t, {
      users: [roman, noChat, fired, brk, fm, home, yan],
      away: { brk: { kind: 'break' }, fm: { kind: 'force_majeure' } },
      ended: ['home'],
    })
    const sent = await runMorningRound(NOW, { ask: ask() })
    assert.equal(sent, 1)
    assert.deepEqual(h.sent.map((m) => m.chatId), ['chat-roman'])
  })

  test('в выходной и ночью не пишет, раунд не создаётся', async (t) => {
    const { h, db } = world(t)
    assert.equal(await runMorningRound(SATURDAY, { ask: ask() }), 0)
    assert.equal(await runMorningRound(new Date('2026-11-03T03:00:00Z'), { ask: ask() }), 0)
    assert.equal(h.sent.length, 0)
    assert.equal(db.rounds.length, 0)
  })

  test('повторный запуск никому не пишет второй раз, и раунд один', async (t) => {
    const { h, db } = world(t)
    await runMorningRound(NOW, { ask: ask() })
    assert.equal(await runMorningRound(new Date(NOW.getTime() + 60000), { ask: ask() }), 0)
    assert.equal(h.sent.length, 3)
    assert.equal(db.rounds.length, 1)
    assert.equal(db.targets.length, 3)
  })

  test('временный сбой телеграма: ключ освобождён, повтор допишет только не получившему', async (t) => {
    const { h, db } = world(t, { users: [roman, oleg, yan] })
    const real = globalThis.fetch
    let fail = true
    globalThis.fetch = async (url, init) => {
      if (fail && String(url).endsWith('sendMessage') && JSON.parse(init.body).chat_id === 'chat-oleg') return new Response(JSON.stringify({ ok: false }), { status: 500 })
      return real(url, init)
    }
    t.after(() => { globalThis.fetch = real })
    assert.equal(await runMorningRound(NOW, { ask: ask() }), 1)
    fail = false
    assert.equal(await runMorningRound(NOW, { ask: ask() }), 1)
    assert.deepEqual(['roman', 'oleg'].map((id) => toUser(h, id).length), [1, 1])
    assert.equal(db.targets.length, 2)
  })

  test('нет админа с телеграмом: обход идёт, владелец поручения любой активный admin', async (t) => {
    const quiet = { ...yan, chat: false }
    const { h, db } = world(t, { users: [roman, quiet] })
    assert.equal(await runMorningRound(NOW, { ask: ask() }), 1)
    assert.equal(db.rounds[0].ownerId, 'yan')
    assert.equal(h.sent.length, 1)
  })
})

describe('текст сообщения', () => {
  test('шаблон при сбое, пустом ответе и зависшей модели: данные человека, без «до 10:00» и штрафов', async (t) => {
    const task = { id: 'x1', title: 'Баннер для Румикс', deadline: new Date('2026-11-01T09:00:00Z'), work: null }
    const { h } = world(t, { users: [roman, oleg, nina, yan], overdue: { roman: task }, counts: { roman: { today: 2, overdue: 1, hierarchy: 3 } } })
    const failing = async ({ user }) => {
      if (user.id === 'roman') throw new Error('сбой модели')
      if (user.id === 'oleg') return null
      return new Promise(() => {})
    }
    await runMorningRound(NOW, { ask: failing, eachMs: 40, totalMs: 4000 })
    const text = toUser(h, 'roman')[0].text
    assert.equal(text, 'Доброе утро, Роман\nНа сегодня у тебя 2 задачи\nПросрочено 1\nОткрыто по Иерархии 3\nМожет, возьмёшь «Баннер для Румикс», она просрочена\nРасставь, пожалуйста, задачи на день')
    assert.equal(toUser(h, 'oleg')[0].text, 'Доброе утро, Олег\nНа сегодня в CRM пока нет задач\nРасставь, пожалуйста, задачи на день')
    assert.equal(toUser(h, 'nina').length, 1)
    for (const m of h.sent) assert.doesNotMatch(m.text, /10:00|штраф|балл/i)
  })

  test('ответ агента уходит как есть, предложенная задача запоминается в цели', async (t) => {
    const hierTask = { id: 'h1', title: 'Лендинг', deadline: new Date('2026-11-10T09:00:00Z'), work: { title: 'Сайт', client: { name: 'Румикс' } } }
    const { h, db } = world(t, { users: [roman, yan], hier: { roman: hierTask } })
    const seen = []
    await runMorningRound(NOW, { ask: async (a) => { seen.push(a.offer); return 'Роман, доброе утро, возьмёшь «Лендинг»' } })
    assert.equal(toUser(h, 'roman')[0].text, 'Роман, доброе утро, возьмёшь «Лендинг»')
    assert.equal(seen[0].why, 'hierarchy')
    assert.equal(db.targets[0].offeredTaskId, 'h1')
    // Источник и привязка к цели: ответ человека потом уйдёт в отчёт.
    assert.ok(h.logged.every((m) => m.source === 'round' && m.roundTargetId === db.targets[0].id))
  })

  test('вызовы к модели идут параллельно, не больше четырёх сразу, и пишут в стиле', async (t) => {
    const users = Array.from({ length: 9 }, (_, i) => ({ ...roman, id: `p${i}`, name: `Имя${i} Фамилия` }))
    world(t, { users: [...users, yan] })
    let live = 0
    let peak = 0
    await runMorningRound(NOW, { ask: async () => { live += 1; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 15)); live -= 1; return null } })
    assert.equal(peak, 4)
  })

  test('шаблон в стиле бота: без точек в конце, двоеточий, скобок, восклицаний и смайликов', () => {
    for (const offer of [null, { title: 'Макет', why: 'overdue' }, { title: 'Лендинг', why: 'hierarchy' }]) {
      for (const f of [{ today: 0 }, { today: 5, overdue: 2, hierarchy: 1 }]) {
        const text = morningTemplate({ name: 'Антон Иванов', ...f, offer })
        assert.doesNotMatch(text, /[!():•—]|\p{Extended_Pictographic}|\.[ \t]*$/mu)
      }
    }
  })
})

describe('какую задачу предлагает', () => {
  test('сначала просроченная не начатая, потом открытая из Иерархии; нет ни той, ни другой, нет предложения', async (t) => {
    const calls = []
    patch(t, prisma.task, 'findFirst', async (q) => { calls.push(q); return calls.length === 1 ? null : { id: 'h', title: 'Лендинг', deadline: new Date(), work: { title: 'Сайт', client: { name: 'К' } } } })
    const offer = await offerFor('roman', NOW)
    assert.equal(offer.why, 'hierarchy')
    assert.equal(offer.client, 'К')
    const [first, second] = calls.map((c) => c.where.AND)
    assert.equal(first[1].status, 'today')
    assert.ok(first[2].deadline.lt)
    assert.equal(second[1].origin, 'hierarchy')
    patch(t, prisma.task, 'findFirst', async () => null)
    assert.equal(await offerFor('roman', NOW), null)
  })
})

describe('разговор по ответу уходит в отчёт', () => {
  test('человек ведёт разговор как по поручению: активная цель обхода, его слова привязаны к ней', async (t) => {
    const calls = patch(t, prisma.botRoundTarget, 'findFirst', async () => ({ id: 't1', status: 'sent', round: { kind: 'morning', owner: yan } }))
    const target = await activeTarget('roman', NOW)
    assert.equal(target.round.kind, 'morning')
    const q = calls[0][0]
    assert.deepEqual(q.where.round, { status: 'sent', collect: true, deadlineAt: { gt: NOW } })
    // Поручение владельца важнее утреннего обхода, если у человека оба.
    assert.deepEqual(q.orderBy, [{ round: { kind: 'asc' } }, { sentAt: 'desc' }])
  })

  test('подсказка разговору: человек ставит задачи сам, отказ с причиной принимается спокойно', () => {
    const text = roundSection({ kind: 'morning', ownerLabel: 'Яна', topic: 'Утренний обход', text: 'Доброе утро', sentAt: NOW, deadlineAt: REPORT_AT, status: 'sent', replies: 1, maxReplies: 6 })
    assert.match(text, /Задачи человек ставит себе сам в CRM\. Ты за него их не ставишь/)
    assert.match(text, /finish_answer/)
    assert.match(text, /В 10:10 Ян и руководители/)
    assert.doesNotMatch(text, /до 10:00/)
    // Обычное поручение не изменилось.
    assert.match(roundSection({ ownerLabel: 'Яна', topic: 'Как дела', text: 'x', sentAt: NOW, deadlineAt: REPORT_AT, status: 'sent', replies: 0, maxReplies: 6 }), /по поручению Яна собираешь ответы/)
  })

  test('вид запроса morning считается в лимитах: сообщение и отчёт укладываются', () => {
    assert.ok(aiLimit('morning', 'staff') >= 2)
    assert.ok(aiLimit('morning', 'lead') >= 2)
  })
})

describe('отчёт в 10:10', () => {
  const sentAt = NOW
  /** Обход с тремя людьми: Роман ответил и поставил задачи, Олег промолчал и без задач, Нина (руководитель) без ответа с задачей. */
  async function prepare(t, extra = {}) {
    const offered = { id: 'x1', ownerId: 'roman', title: 'Баннер', status: 'today', deadline: new Date('2026-11-03T15:00:00Z'), updatedAt: new Date('2026-11-03T06:30:00Z') }
    const w = world(t, {
      tasks: [
        { ownerId: 'roman', title: 'Макет сайта', createdAt: new Date('2026-11-03T06:55:00Z') },
        { ownerId: 'roman', title: 'Правки по баннеру', createdAt: new Date('2026-11-02T10:00:00Z') },
        { ownerId: 'nina', title: 'Планёрка', createdAt: new Date('2026-11-02T10:00:00Z') },
      ],
      ...extra,
    })
    w.db.offered.push(offered)
    await runMorningRound(NOW, { ask: ask() })
    // Сообщения ушли в 9:40 обхода (бот ставит sentAt по часам процесса).
    for (const x of w.db.targets) if (x.sentAt) x.sentAt = sentAt
    const target = w.db.targets.find((x) => x.userId === 'roman')
    target.offeredTaskId = 'x1'
    target.messages = [
      { direction: 'in', text: 'Баннер не возьму, сегодня запись в больницу', createdAt: new Date('2026-11-03T06:45:00Z'), source: null },
    ]
    target.summary = 'Не возьмёт баннер, сегодня в больницу'
    w.h.sent.length = 0
    return w
  }
  const noModel = async () => null

  test('Яну один отчёт по всем, руководителю только по его отделу; не ответившие одной строкой', async (t) => {
    const { h, db } = await prepare(t)
    const res = await sendMorningReport('r1', REPORT_AT, { lines: noModel })
    assert.equal(res.ok, true)
    assert.equal(db.rounds[0].status, 'closed')
    const toYan = toUser(h, 'yan')
    const toNina = toUser(h, 'nina')
    assert.equal(toYan.length, 1)
    assert.equal(toNina.length, 1)
    assert.equal(toUser(h, 'roman').length + toUser(h, 'oleg').length, 0)
    // Яну все трое, Нина тоже как человек обхода.
    assert.match(toYan[0].text, /^<b>Утренний обход<\/b>\nОтветили 1 из 3, после сообщения задачи поставили 1/)
    assert.match(toYan[0].text, /<b>Роман, дизайн<\/b>/)
    assert.match(toYan[0].text, /<b>Нина, дизайн<\/b>/)
    assert.match(toYan[0].text, /<b>Не ответили и ничего не поставили<\/b> Олег, SEO$/)
    // Руководитель дизайна видит Романа, но не Олега из SEO и не себя.
    assert.match(toNina[0].text, /Роман, дизайн/)
    assert.doesNotMatch(toNina[0].text, /Олег|SEO|Нина/)
    assert.doesNotMatch(toNina[0].text, /Не ответили и ничего/)
    assert.match(toNina[0].text, /^<b>Утренний обход<\/b>\nОтветили 1 из 1, после сообщения задачи поставили 1/)
  })

  test('свежие задачи из базы и судьба предложенной: что поставил, взял ли, что ответил', async (t) => {
    const { h } = await prepare(t)
    await sendMorningReport('r1', REPORT_AT, { lines: noModel })
    const text = toUser(h, 'yan')[0].text
    const roman = text.split('\n\n').find((p) => p.startsWith('<b>Роман'))
    assert.equal(roman, '<b>Роман, дизайн</b>\nОтветил «Не возьмёт баннер, сегодня в больницу»\nНа сегодня 2 задачи\nПосле моего сообщения поставил 1\n«Макет сайта»\n«Правки по баннеру»\nПредложенную «Баннер» пока не взял')
  })

  test('читает задачи заново: в запрос идёт только сегодняшний срок, и берёт состояние на момент отчёта', async (t) => {
    const w = await prepare(t)
    const seen = patch(t, prisma.task, 'findMany', async ({ where }) => {
      if (where.AND[1].id) return [{ id: 'x1', ownerId: 'roman', title: 'Баннер', status: 'progress', deadline: new Date('2026-11-03T15:00:00Z'), updatedAt: new Date('2026-11-03T07:00:00Z') }]
      return []
    })
    const counted = patch(t, prisma.task, 'groupBy', async () => [])
    await sendMorningReport('r1', REPORT_AT, { lines: noModel })
    // Числа считает база по ownerId, названия отдельными запросами не больше пяти на человека.
    assert.equal(counted.length, 1)
    const tasksQuery = counted[0][0].where.AND[1]
    assert.deepEqual(tasksQuery.ownerId.in.sort(), ['nina', 'oleg', 'roman'])
    assert.equal(tasksQuery.deadline.gte.toISOString(), '2026-11-02T21:00:00.000Z')
    assert.ok(seen.filter(([q]) => q.take === 5).length >= 2)
    assert.match(toUser(w.h, 'yan')[0].text, /Предложенную «Баннер» взял в работу/)
  })

  test('отчёт моделью: строки модели вместо шаблона, у кого их нет, шаблон', async (t) => {
    const { h } = await prepare(t)
    const given = []
    await sendMorningReport('r1', REPORT_AT, { lines: async ({ people }) => { given.push(...people.map((p) => p.id)); return { roman: { lines: ['Поставил две задачи', 'Баннер не возьмёт, сегодня запись в больницу'] } } } })
    assert.deepEqual(given.sort(), ['nina', 'roman'])
    const text = toUser(h, 'yan')[0].text
    assert.match(text, /<b>Роман, дизайн<\/b>\nПоставил две задачи\nБаннер не возьмёт, сегодня запись в больницу\n\n<b>Нина, дизайн<\/b>\nНе ответил\nНа сегодня 1 задача\nПосле моего сообщения ничего не ставил/)
  })

  test('отчёт уходит один раз: повторный запуск и застрявший отчёт ничего не дублируют', async (t) => {
    const { h, db } = await prepare(t)
    await sendMorningReport('r1', REPORT_AT, { lines: noModel })
    assert.deepEqual((await sendMorningReport('r1', REPORT_AT, { lines: noModel })).reason, 'busy')
    db.rounds[0].status = 'sent'
    await sendMorningReport('r1', REPORT_AT, { lines: noModel })
    assert.equal(toUser(h, 'yan').length, 1)
    assert.equal(toUser(h, 'nina').length, 1)
  })

  test('сбой телеграма у руководителя: повтор отправит только ему', async (t) => {
    const { h, db } = await prepare(t)
    const real = globalThis.fetch
    let fail = true
    globalThis.fetch = async (url, init) => {
      if (fail && String(url).endsWith('sendMessage') && JSON.parse(init.body).chat_id === 'chat-nina') return new Response(JSON.stringify({ ok: false }), { status: 500 })
      return real(url, init)
    }
    t.after(() => { globalThis.fetch = real })
    const first = await sendMorningReport('r1', REPORT_AT, { lines: noModel })
    assert.equal(first.reason, 'telegram')
    assert.equal(db.rounds[0].status, 'sent')
    fail = false
    await sendMorningReport('r1', REPORT_AT, { lines: noModel })
    assert.equal(toUser(h, 'yan').length, 1)
    assert.equal(toUser(h, 'nina').length, 1)
    assert.equal(db.rounds[0].status, 'closed')
  })

  test('никто не получил сообщение: в отчёте строка «не дошло», отчёт руководителю без его людей не уходит', async (t) => {
    const w = await prepare(t)
    w.db.targets.find((x) => x.userId === 'oleg').status = 'failed'
    w.db.targets.find((x) => x.userId === 'roman').status = 'failed'
    await sendMorningReport('r1', REPORT_AT, { lines: noModel })
    const text = toUser(w.h, 'yan')[0].text
    assert.match(text, /<b>Сообщение не дошло<\/b> Роман, дизайн; Олег, SEO$/)
  })

  test('без штрафов и баллов: ни событий, ни заявок за весь обход и отчёт', async (t) => {
    const w = await prepare(t)
    await sendMorningReport('r1', REPORT_AT, { lines: noModel })
    assert.deepEqual(w.penalties, [])
  })

  test('тик: отчёт в 10:10, не раньше; ночной хвост через три часа закрывается без отчёта', async (t) => {
    const w = await prepare(t)
    await tickMorning(new Date('2026-11-03T07:09:00Z'))
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(w.h.sent.length, 0)
    await tickMorning(REPORT_AT)
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(toUser(w.h, 'yan').length, 1)
    w.db.rounds[0].status = 'sent'
    w.h.sent.length = 0
    const stale = new Date('2026-11-03T12:00:00Z')
    assert.equal((await sendMorningReport('r1', stale, { lines: noModel })).reason, 'stale')
    assert.equal(w.db.rounds[0].status, 'closed')
    assert.equal(w.h.sent.length, 0)
  })

  test('нет обхода за день и уже 9:45: тик догоняет, а в 9:40 и в выходные не вмешивается', async (t) => {
    const w = world(t, { users: [roman, yan] })
    await tickMorning(NOW)
    assert.equal(w.h.sent.length, 0)
    await tickMorning(new Date('2026-11-07T06:45:00Z'))
    assert.equal(w.h.sent.length, 0)
    await tickMorning(new Date('2026-11-03T06:45:00Z'))
    assert.equal(w.h.sent.length, 1)
  })
})

describe('отчёт и сообщение, текст', () => {
  const p = (over = {}) => ({ userId: 'a', label: 'Роман, дизайн', status: 'answered', summary: null, messages: [], answered: false, tasks: { count: 0, titles: [], offer: null }, ...over })

  test('состояние предложенной задачи', () => {
    const sent = NOW
    const base = { deadline: new Date('2026-11-03T15:00:00Z'), updatedAt: new Date('2026-11-03T05:00:00Z') }
    assert.equal(offerState(null, sent, REPORT_AT), 'gone')
    assert.equal(offerState({ ...base, status: 'done' }, sent, REPORT_AT), 'done')
    assert.equal(offerState({ ...base, status: 'progress' }, sent, REPORT_AT), 'progress')
    assert.equal(offerState({ ...base, status: 'today' }, sent, REPORT_AT), 'untouched')
    assert.equal(offerState({ ...base, status: 'today', updatedAt: new Date('2026-11-03T06:55:00Z') }, sent, REPORT_AT), 'today')
    // Срок не сегодня: даже правка не делает её задачей на сегодня.
    assert.equal(offerState({ ...base, status: 'today', deadline: new Date('2026-11-09T15:00:00Z'), updatedAt: REPORT_AT }, sent, REPORT_AT), 'untouched')
  })

  test('шаблон отчёта в стиле бота, без маркеров, точек в конце, двоеточий, скобок и баллов', () => {
    const people = [
      p({ answered: true, summary: 'Берёт баннер сегодня после обеда', tasks: { count: 4, fresh: 2, titles: [{ title: 'Макет' }, { title: 'Баннер' }, { title: 'Правки' }, { title: 'Отчёт' }], offer: { title: 'Баннер', state: 'progress' } } }),
      p({ userId: 'b', label: 'Олег, SEO', tasks: { count: 1, fresh: 1, titles: [{ title: 'Статья' }], offer: { title: 'Аудит', state: 'untouched' } } }),
      p({ userId: 'c', label: 'Нина, дизайн' }),
      p({ userId: 'd', label: 'Игорь, SMM', status: 'failed' }),
    ]
    const text = morningReportText({ people })
    const clean = text.replace(/<[^>]+>/g, '')
    assert.doesNotMatch(clean, /[!()•—]|\p{Extended_Pictographic}|(^|[^\d]):|:(?!\d)|\.[ \t]*$|балл|штраф|до 10:00/imu)
    assert.match(text, /Ответили 1 из 3, после сообщения задачи поставили 2/)
    assert.match(text, /На сегодня 4 задачи\nПосле моего сообщения поставил 2\n«Макет»\n«Баннер»\n«Правки»\nи ещё 1/)
    assert.match(text, /<b>Не ответили и ничего не поставили<\/b> Нина, дизайн\n\n<b>Сообщение не дошло<\/b> Игорь, SMM$/)
    assert.deepEqual(personTemplate(p()), ['Не ответил', 'На сегодня задач нет'])
  })

  test('строки модели чистятся до стиля бота и не пропускают ссылки', async () => {
    const out = await morningLines({ ownerId: 'yan', role: 'admin', people: [{ id: 'roman', label: 'Роман, дизайн', summary: null, messages: [{ direction: 'in', text: 'Сегодня к врачу', createdAt: NOW }], tasks: { count: 1, titles: [{ title: 'Макет', fresh: true }], offer: { title: 'Баннер', state: 'untouched' } } }] }, {
      pick: async () => ({ model: 'claude-sonnet-5-5' }), can: async () => true, take: async () => true, record: async () => {}, sharedNotes: '',
      create: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ lines: ['Поставил «Макет»!', 'Идёт к врачу — смотри t.me/x.'] }) }], usage: { input_tokens: 1, output_tokens: 1 } }),
    })
    assert.deepEqual(out.roman.lines, ['Поставил «Макет»', 'Идёт к врачу, смотри ссылка'])
  })

  test('нет ключа, лимит или бюджет: сообщение и строки отчёта null, бот возьмёт шаблон', async () => {
    const key = env.anthropicApiKey
    env.anthropicApiKey = ''
    try {
      assert.equal(await morningText({ user: { id: 'u', role: 'staff' }, now: NOW }), null)
      assert.equal(await morningLines({ ownerId: 'yan', people: [] }), null)
    } finally {
      env.anthropicApiKey = key
    }
    const deps = { pick: async () => ({ model: 'm' }), can: async () => false, take: async () => true, record: async () => {}, brief: '', rows: [], shared: '', personal: '' }
    assert.equal(await morningText({ user: { id: 'u', role: 'staff' }, now: NOW }, deps), null)
  })

  test('сообщение моделью: kind morning, без инструментов, только данные этого человека, предложенная задача названа', async () => {
    const seen = []
    const deps = {
      pick: async () => ({ model: 'claude-sonnet-5-5' }), can: async () => true, take: async () => true, record: async () => {},
      brief: 'Данные Романа', rows: [], shared: '', personal: '',
      create: async (params) => { seen.push(params); return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Роман, доброе утро!\nВозьмёшь «Баннер»?' }], usage: { input_tokens: 1, output_tokens: 1 } } },
    }
    const text = await morningText({ user: { id: 'roman', role: 'staff' }, offer: { title: 'Баннер', why: 'overdue', deadline: new Date('2026-11-01T09:00:00Z') }, now: NOW }, deps)
    assert.equal(text, 'Роман, доброе утро\nВозьмёшь «Баннер»?')
    assert.equal(seen.length, 1)
    assert.equal(seen[0].tools, undefined)
    const body = JSON.stringify(seen[0].messages)
    assert.match(body, /Данные Романа/)
    assert.match(body, /Предложи ему взять задачу «Баннер», она просрочена/)
    assert.doesNotMatch(JSON.stringify(seen[0].system), /до 10:00/)
  })
})

describe('обход дописывается и ничего не теряется', () => {
  const minute = (m) => new Date(`2026-11-03T06:${String(m).padStart(2, '0')}:00Z`)

  test('временный сбой телеграма у одного: следующий тик дописывает только его', async (t) => {
    const { h, db } = world(t, { users: [roman, oleg, yan] })
    const real = globalThis.fetch
    let fail = true
    globalThis.fetch = async (url, init) => {
      if (fail && String(url).endsWith('sendMessage') && JSON.parse(init.body).chat_id === 'chat-oleg') return new Response(JSON.stringify({ ok: false }), { status: 500 })
      return real(url, init)
    }
    t.after(() => { globalThis.fetch = real })
    await runMorningRound(NOW, { ask: ask() })
    assert.deepEqual(['roman', 'oleg'].map((id) => toUser(h, id).length), [1, 0])
    fail = false
    await tickMorning(minute(41))
    assert.deepEqual(['roman', 'oleg'].map((id) => toUser(h, id).length), [1, 1])
    assert.equal(db.rounds.length, 1)
    // Все получили: следующий тик ничего не делает.
    await tickMorning(minute(42))
    assert.equal(h.sent.length, 2)
  })

  test('рестарт после создания раунда: тик дописывает остальных, написанному не пишет', async (t) => {
    const { h, db } = world(t, { users: [roman, oleg, nina, yan] })
    // До рестарта успели написать только Роману: раунд и ключ есть, остальных нет.
    db.rounds.push({ id: 'r1', kind: 'morning', ownerId: 'yan', status: 'sent', reportTries: 0, createdAt: NOW, sentAt: NOW, deadlineAt: REPORT_AT })
    h.notices.add('morning-round:2026-11-03:roman')
    db.targets.push({ id: 't0', roundId: 'r1', userId: 'roman', status: 'sent', messages: [] })
    await tickMorning(minute(45))
    assert.deepEqual(['roman', 'oleg', 'nina'].map((id) => toUser(h, id).length), [0, 1, 1])
    assert.equal(db.rounds.length, 1)
  })

  test('после 10:00 тик уже не догоняет', async (t) => {
    const { h } = world(t, { users: [roman, yan] })
    await tickMorning(new Date('2026-11-03T07:01:00Z'))
    assert.equal(h.sent.length, 0)
  })

  test('нет ни одного admin: никому не пишет, в лог один раз в день, а не каждую минуту', async (t) => {
    const { h, db } = world(t, { users: [roman, oleg] })
    const logged = patch(t, console, 'error', () => {})
    for (const m of [40, 41, 42]) await runMorningRound(minute(m), { ask: ask() })
    assert.equal(h.sent.length, 0)
    assert.equal(db.rounds.length, 0)
    assert.equal(logged.filter(([msg]) => /нет активного владельца/.test(msg)).length, 1)
  })

  test('цели pending и skipped не пропадают из отчёта: строка «Не получили сообщение»', async (t) => {
    const w = world(t, { tasks: [] })
    await runMorningRound(NOW, { ask: ask() })
    w.db.targets.find((x) => x.userId === 'oleg').status = 'pending'
    w.db.targets.find((x) => x.userId === 'nina').status = 'skipped'
    w.h.sent.length = 0
    await sendMorningReport('r1', REPORT_AT, { lines: async () => null })
    const text = toUser(w.h, 'yan')[0].text
    assert.match(text, /Ответили 0 из 1/)
    assert.match(text, /<b>Не получили сообщение<\/b> Нина, дизайн; Олег, SEO$/)
    // Руководитель дизайна не увидит чужого отдела; про Романа у него обычная строка.
    assert.doesNotMatch(toUser(w.h, 'nina')[0].text, /Олег/)
  })
})

describe('отчёт не держит захваченную часть и считает честно', () => {
  async function ready(t) {
    const w = world(t, { tasks: [{ ownerId: 'roman', title: 'Макет', createdAt: NOW }] })
    await runMorningRound(NOW, { ask: ask() })
    w.h.sent.length = 0
    return w
  }

  test('строки моделью готовятся до захвата частей отправки', async (t) => {
    const w = await ready(t)
    const order = []
    const base = w.h.notices.add.bind(w.h.notices)
    w.h.notices.add = (key) => { if (key.startsWith('round-report:')) order.push(`claim ${key.split(':')[2]}`); return base(key) }
    await sendMorningReport('r1', REPORT_AT, { lines: async () => { order.push('lines'); return null } })
    assert.equal(order[0], 'lines')
    assert.ok(order.length > 1)
  })

  test('застрявший отчёт обхода возвращает в «sent» тик обхода со своим порогом, а тик поручений его не трогает', async (t) => {
    const w = world(t, { users: [roman, yan] })
    const calls = patch(t, prisma.botRound, 'updateMany', async () => ({ count: 0 }))
    await tickMorning(new Date('2026-11-03T07:20:00Z'))
    const reset = calls.find(([q]) => q.where.status === 'reporting')[0]
    assert.equal(reset.where.kind, 'morning')
    assert.equal(reset.where.closedAt.lt.toISOString(), '2026-11-03T07:05:00.000Z')
    assert.ok(w)
    const { tickRounds } = await import('../agent/rounds.js')
    calls.length = 0
    patch(t, prisma.botRound, 'findMany', async () => [])
    await tickRounds(REPORT_AT)
    assert.equal(calls.find(([q]) => q.where.status === 'reporting')[0].where.kind, 'ask')
  })

  test('в сообщении и в отчёте «на сегодня» считается одинаково: все статусы со сроком сегодня', async (t) => {
    const asked = patch(t, prisma.task, 'count', async () => 0)
    const { morningFacts } = await import('../agent/morning.js')
    await morningFacts('roman', NOW)
    const where = asked[0][0].where.AND[1]
    assert.equal(where.status, undefined)
    assert.ok(where.deadline.gte && where.deadline.lt)
    const w = await ready(t)
    assert.ok(w)
  })

  test('предложенная чужая задача не считается взятой', async (t) => {
    const w = await ready(t)
    w.db.targets.find((x) => x.userId === 'roman').offeredTaskId = 'x9'
    w.db.offered.push({ id: 'x9', ownerId: 'oleg', title: 'Чужая', status: 'done', deadline: NOW, updatedAt: NOW })
    await sendMorningReport('r1', REPORT_AT, { lines: async () => null })
    assert.doesNotMatch(toUser(w.h, 'yan')[0].text, /Чужая/)
  })

  test('в цели лежит исходный текст без HTML, в телеграм уходит экранированный', async (t) => {
    const w = world(t, { users: [roman, yan] })
    await runMorningRound(NOW, { ask: async () => 'Роман, A & B' })
    assert.equal(w.db.targets[0].text, 'Роман, A & B')
    assert.equal(toUser(w.h, 'roman')[0].text, 'Роман, A &amp; B')
  })

  test('слова человека в шаблоне отчёта приведены к стилю бота', () => {
    const lines = personTemplate({ answered: true, summary: 'Делает: макет (почти) — потом баннер!', messages: [], tasks: { count: 1, fresh: 0, titles: [{ title: 'Макет (правки): срочно!' }], offer: null } })
    const text = lines.join('\n')
    assert.doesNotMatch(text, /[:!—]|\(|\)/)
    assert.match(text, /После моего сообщения ничего не ставил/)
  })
})

describe('строки отчёта моделью: учёт вызовов и время', () => {
  const person = (id) => ({ id, label: `${id}, дизайн`, summary: null, messages: [], tasks: { count: 1, fresh: 0, titles: [{ title: 'Макет', fresh: false }], offer: null } })
  const reply = { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ lines: ['Строка'] }) }], usage: { input_tokens: 1, output_tokens: 1 } }
  const deps = (over = {}) => ({ pick: async () => ({ model: 'm' }), can: async () => true, record: async () => {}, sharedNotes: '', ...over })

  test('каждый запрос к модели занимает место в лимите, а не один на весь отчёт', async () => {
    const takes = []
    let calls = 0
    const out = await morningLines({ ownerId: 'yan', people: [person('a'), person('b'), person('c')] }, deps({
      take: async (id, kind) => { takes.push(kind); return true },
      create: async () => { calls += 1; return reply },
    }))
    assert.equal(calls, 3)
    assert.deepEqual(takes, ['morningReport', 'morningReport', 'morningReport'])
    assert.deepEqual(Object.keys(out).sort(), ['a', 'b', 'c'])
  })

  test('лимит кончился посреди отчёта: у кого есть строки, у остальных шаблон', async () => {
    let n = 0
    const out = await morningLines({ ownerId: 'yan', people: [person('a'), person('b'), person('c')] }, deps({
      take: async () => { n += 1; return n <= 1 },
      create: async () => reply,
    }))
    assert.deepEqual(Object.keys(out), ['a'])
  })

  test('общее время вышло: запросов к модели нет, отчёт целиком шаблоном', async () => {
    let calls = 0
    const out = await morningLines({ ownerId: 'yan', people: [person('a')] }, deps({ take: async () => true, totalMs: 1000, create: async () => { calls += 1; return reply } }))
    assert.equal(calls, 0)
    assert.equal(out, null)
  })

  test('лимит на отчёт вмещает 25 человек', () => {
    assert.ok(aiLimit('morningReport', 'admin') >= 25)
  })
})

describe('обход не спорит с опросом Яна', () => {
  test('у человека идёт опрос Яна: утреннее ему не пишем, в отчёте отдельной строкой', async (t) => {
    const { h, db } = world(t, { asks: { oleg: { id: 'ask1' } } })
    await runMorningRound(NOW, { ask: ask() })
    assert.equal(toUser(h, 'oleg').length, 0)
    assert.equal(toUser(h, 'roman').length, 1)
    assert.equal(db.targets.find((x) => x.userId === 'oleg').status, 'busy')
    // Догоняющий проход тоже не пишет: ключ занят.
    await runMorningRound(new Date(NOW.getTime() + 5 * 60000), { ask: ask() })
    assert.equal(toUser(h, 'oleg').length, 0)
    for (const x of db.targets) if (x.sentAt) x.sentAt = NOW
    db.own.push({ userId: 'oleg', direction: 'reply', text: 'Да, на связи, делаю отчёт', createdAt: new Date('2026-11-03T06:36:00Z') })
    h.sent.length = 0
    await sendMorningReport('r1', REPORT_AT, { lines: async () => null })
    const toYan = toUser(h, 'yan')[0].text
    assert.match(toYan, /Ответили 1 из 3/)
    assert.match(toYan, /<b>Утреннее не слал, шёл твой опрос<\/b> Олег, SEO/)
    assert.match(toYan, /Ответил «Да, на связи, делаю отчёт»/)
  })

  test('ответ мимо обхода тоже ответ: командой после сообщения, а не в разговор', async (t) => {
    const { h, db } = world(t)
    await runMorningRound(NOW, { ask: ask() })
    for (const x of db.targets) if (x.sentAt) x.sentAt = NOW
    db.own.push({ userId: 'roman', direction: 'in', text: 'Поставь галочку на макет', createdAt: new Date('2026-11-03T06:50:00Z') })
    // До 9:30 — это вчерашнее и не ответ.
    db.own.push({ userId: 'nina', direction: 'in', text: 'Старое', createdAt: new Date('2026-11-03T06:00:00Z') })
    h.sent.length = 0
    await sendMorningReport('r1', REPORT_AT, { lines: async () => null })
    assert.match(toUser(h, 'yan')[0].text, /Ответили 1 из 3/)
  })
})
