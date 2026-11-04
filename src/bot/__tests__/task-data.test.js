import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { prisma } from '../../config/prisma.js'
import { patch } from './patch.js'
import { countsText, taskLine, tasksBlock, worksBrief } from '../ai/context.js'
import { dayWord, dueText, isOverdue, metricWhere, stateWord, taskCounts, tasksOf, VISIBLE } from '../agent/taskScope.js'

// 4 ноября, 17:00 по Москве. Московский день: с 3 ноября 21:00 до 4 ноября 21:00 UTC.
const NOW = new Date('2026-11-04T14:00:00Z')
const at = (iso) => new Date(iso)
const task = (extra = {}) => ({ id: 't', title: 'Макет', status: 'today', origin: 'personal', deadline: at('2026-11-04T16:00:00Z'), startAt: null, doneAt: null, work: null, ownerId: 'u1', ...extra })

describe('какие задачи считает агент', () => {
  test('видны личные и задачи Иерархии только из работ в статусе active', () => {
    assert.deepEqual(VISIBLE, { OR: [{ origin: 'personal' }, { origin: 'hierarchy', work: { status: 'active' } }] })
  })

  test('просрочена как в CRM: не сделана и срок меньше «сейчас», а не меньше начала дня', () => {
    assert.deepEqual(metricWhere('overdue', NOW).deadline, { lt: NOW })
    assert.equal(isOverdue(task({ deadline: at('2026-11-04T13:59:00Z') }), NOW), true)
    assert.equal(isOverdue(task({ deadline: at('2026-11-04T14:00:00Z') }), NOW), false)
    assert.equal(isOverdue(task({ status: 'done', deadline: at('2026-11-01T10:00:00Z') }), NOW), false)
  })

  test('не просроченное делится на «сегодня» и «завтра и позже» по концу московского дня', () => {
    assert.deepEqual(metricWhere('today', NOW).deadline, { gte: NOW, lt: at('2026-11-04T21:00:00Z') })
    assert.deepEqual(metricWhere('later', NOW).deadline, { gte: at('2026-11-04T21:00:00Z') })
    assert.deepEqual(metricWhere('notStarted', NOW), { status: 'today', deadline: { lt: at('2026-11-04T21:00:00Z') } })
    assert.deepEqual(metricWhere('done', NOW).doneAt, { gte: at('2026-11-03T21:00:00Z') })
    assert.throws(() => metricWhere('что-то', NOW))
  })

  test('числа раздельно по личным и Иерархии, через groupBy, и в каждом запросе фильтр видимости', async (t) => {
    const wheres = []
    patch(t, prisma.task, 'groupBy', async ({ where }) => {
      wheres.push(where)
      const overdue = where.AND[2].deadline?.lt === NOW
      if (overdue) return [{ ownerId: 'u1', origin: 'personal', _count: 2 }, { ownerId: 'u1', origin: 'hierarchy', _count: 1 }]
      if (where.AND[2].status === 'progress') return [{ ownerId: 'u1', origin: 'hierarchy', _count: 4 }]
      if (where.AND[2].deadline?.gte?.getTime() === NOW.getTime()) return [{ ownerId: 'u2', origin: 'personal', _count: 3 }]
      return []
    })
    const counts = await taskCounts(['u1', 'u2', 'u1'], NOW)
    assert.equal(wheres.length, 6)
    assert.ok(wheres.every((w) => w.AND[0] === VISIBLE && w.AND[1].ownerId.in.length === 2))
    assert.deepEqual(counts.get('u1').personal, { open: 2, overdue: 2, today: 0, later: 0, progress: 0, notStarted: 0, done: 0 })
    assert.equal(counts.get('u1').hierarchy.overdue, 1)
    assert.equal(counts.get('u1').hierarchy.progress, 4)
    assert.equal(counts.get('u2').personal.today, 3)
    assert.equal(counts.get('u2').personal.open, 3)
    assert.equal(counts.get('u2').hierarchy.open, 0)
  })

  test('списки спрашиваем, только если по счёту в них что-то есть, и не длиннее take', async (t) => {
    patch(t, prisma.task, 'groupBy', async ({ where }) => (where.AND[2].deadline?.lt === NOW ? [{ ownerId: 'u1', origin: 'personal', _count: 25 }] : []))
    const asked = []
    patch(t, prisma.task, 'findMany', async ({ where, take }) => {
      asked.push({ origin: where.AND[1].origin, take })
      return [task()]
    })
    const sections = await tasksOf('u1', NOW, { overdue: 10, today: 20, later: 0, done: 5 })
    assert.deepEqual(asked, [{ origin: 'personal', take: 10 }])
    assert.equal(sections[0].counts.overdue, 25)
    assert.equal(sections[0].lists.overdue.length, 1)
    assert.deepEqual(sections.map((s) => s.kind), ['personal', 'hierarchy'])
  })
})

describe('как называем состояние задачи', () => {
  test('личная: не начата или в процессе', () => {
    assert.equal(stateWord(task({ status: 'today' }), NOW), 'не начата')
    assert.equal(stateWord(task({ status: 'progress' }), NOW), 'в процессе')
    assert.equal(stateWord(task({ status: 'done' }), NOW), 'сделана')
  })

  test('из Иерархии: открыта, а не «не начата»; в процессе, если взяли', () => {
    assert.equal(stateWord(task({ origin: 'hierarchy', status: 'today' }), NOW), 'открыта')
    assert.equal(stateWord(task({ origin: 'hierarchy', status: 'progress' }), NOW), 'в процессе')
  })

  test('срок в будущие дни: «на завтра» или «на 7 ноября», не «не начата» и не «открыта»', () => {
    const tomorrow = at('2026-11-05T09:00:00Z')
    const later = at('2026-11-07T09:00:00Z')
    assert.equal(stateWord(task({ deadline: tomorrow }), NOW), 'на завтра')
    assert.equal(stateWord(task({ origin: 'hierarchy', deadline: later }), NOW), 'на 7 ноября')
    assert.equal(dayWord(tomorrow, NOW), 'на завтра')
    assert.equal(stateWord(task({ status: 'progress', deadline: later }), NOW), 'в процессе')
  })

  test('срок словами: сегодня, завтра, дата', () => {
    assert.equal(dueText(task({ deadline: at('2026-11-04T16:00:00Z') }), NOW), 'срок сегодня 19:00')
    assert.equal(dueText(task({ status: 'progress', deadline: at('2026-11-05T09:00:00Z') }), NOW), 'срок завтра 12:00')
    assert.equal(dueText(task({ deadline: at('2026-11-03T09:00:00Z') }), NOW), 'срок 3 ноября')
    assert.equal(dueText(task({ deadline: at('2026-11-05T09:00:00Z') }), NOW), 'до 12:00')
  })
})

describe('данные задач для агента', () => {
  test('строка: владелец первым, просроченная помечена, у Иерархии клиент и работа', () => {
    const line = taskLine(task({ origin: 'hierarchy', status: 'progress', deadline: at('2026-11-03T09:00:00Z'), work: { title: 'Лендинг', client: { name: 'Румикс' } } }), NOW, { owner: '(Дизайн) Роман' })
    assert.equal(line, '- (Дизайн) Роман, «Макет», в процессе, просрочена, срок 3 ноября, клиент Румикс, работа «Лендинг»')
  })

  test('у задачи на завтра нет слов «не начата» и «просрочена»', () => {
    const line = taskLine(task({ deadline: at('2026-11-05T09:00:00Z') }), NOW)
    assert.equal(line, '- «Макет», на завтра, до 12:00')
    assert.doesNotMatch(line, /не начата|просрочена/)
  })

  test('сделанная: время закрытия, без срока', () => {
    assert.equal(taskLine(task({ status: 'done', doneAt: at('2026-11-04T10:00:00Z') }), NOW), '- «Макет», сделана в 13:00')
  })

  test('числа: у личных есть «не начато», у Иерархии нет', () => {
    const c = { open: 5, notStarted: 2, progress: 1, overdue: 3, later: 1, done: 4 }
    assert.equal(countsText('personal', c), 'открыто 5, не начато 2, в процессе 1, просрочено 3, на завтра и позже 1, сделано сегодня 4')
    assert.equal(countsText('hierarchy', c, { later: false }), 'открыто 5, в процессе 1, просрочено 3, сделано сегодня 4')
  })

  test('в заголовке настоящее число, а не длина обрезанного списка', () => {
    const counts = { personal: { open: 30, notStarted: 0, progress: 0, overdue: 25, today: 5, later: 0, done: 0 }, hierarchy: { open: 0, notStarted: 0, progress: 0, overdue: 0, today: 0, later: 0, done: 0 } }
    const sections = [
      { kind: 'personal', counts: counts.personal, lists: { overdue: [task({ title: 'А', deadline: at('2026-11-03T09:00:00Z') })], today: [], later: [], done: [] } },
      { kind: 'hierarchy', counts: counts.hierarchy, lists: { overdue: [], today: [], later: [], done: [] } },
    ]
    const text = tasksBlock(sections, NOW)
    assert.match(text, /Личные задачи\nоткрыто 30/)
    assert.match(text, /Просроченные, 25\n- «А»[^\n]*\nи ещё 24/)
    assert.match(text, /Задачи по Иерархии\nоткрыто 0/)
  })
})

describe('работы в Иерархии: у каждого его задачи с именем', () => {
  test('по человеку числа и строки с «(Отдел) Имя», остаток «и ещё»', async (t) => {
    const roman = { id: 'r', name: 'Роман Котов', role: 'staff', active: true, departmentId: 'd', department: { name: 'Дизайн' } }
    const igor = { id: 'i', name: 'Игорь Орлов', role: 'staff', active: true, departmentId: 'd2', department: { name: 'Разработка' } }
    patch(t, prisma.work, 'findMany', async () => [{ id: 'w1', title: 'Лендинг', client: { name: 'Румикс' }, department: { name: 'Дизайн' }, assignees: [roman] }])
    patch(t, prisma.work, 'count', async () => 1)
    patch(t, prisma.task, 'groupBy', async ({ where }) => {
      const base = [{ workId: 'w1', ownerId: 'r', _count: 8 }, { workId: 'w1', ownerId: 'i', _count: 1 }]
      if (where.status === 'progress') return [{ workId: 'w1', ownerId: 'r', _count: 2 }]
      if (where.deadline) return [{ workId: 'w1', ownerId: 'i', _count: 1 }]
      return base
    })
    patch(t, prisma.task, 'findMany', async () => Array.from({ length: 9 }, (_, i) => ({ id: `t${i}`, title: `Задача ${i}`, status: 'today', origin: 'hierarchy', deadline: at('2026-11-04T16:00:00Z'), startAt: null, doneAt: null, ownerId: i < 8 ? 'r' : 'i', workId: 'w1' })))
    patch(t, prisma.user, 'findMany', async () => [roman, igor])
    const text = await worksBrief({ role: 'admin' }, null, NOW)
    assert.match(text, /открыто задач 9, в процессе 2, просрочено 1/)
    assert.match(text, /\n  \(Дизайн\) Роман, открыто 8, в процессе 2, просрочено 0/)
    assert.match(text, /\n  \(Разработка\) Игорь, открыто 1, в процессе 0, просрочено 1/)
    assert.match(text, /\n  - \(Дизайн\) Роман, «Задача 0», открыта, срок сегодня 19:00/)
    assert.match(text, /и ещё 3$/)
  })

  test('руководитель: люди из других отделов без имён и задач, только сумма', async (t) => {
    const roman = { id: 'r', name: 'Роман Котов', role: 'staff', active: true, departmentId: 'd', department: { name: 'Дизайн' } }
    patch(t, prisma.work, 'findMany', async () => [{ id: 'w1', title: 'Лендинг', client: { name: 'Румикс' }, department: { name: 'Дизайн' }, assignees: [roman] }])
    patch(t, prisma.work, 'count', async () => 1)
    patch(t, prisma.task, 'groupBy', async ({ where }) => {
      const base = [{ workId: 'w1', ownerId: 'r', _count: 2 }, { workId: 'w1', ownerId: 'igor', _count: 3 }]
      if (where.status === 'progress') return [{ workId: 'w1', ownerId: 'igor', _count: 1 }]
      if (where.deadline) return [{ workId: 'w1', ownerId: 'igor', _count: 2 }]
      return base
    })
    const samples = patch(t, prisma.task, 'findMany', async ({ where }) => [{ id: 't0', title: 'Свой макет', status: 'today', origin: 'hierarchy', deadline: at('2026-11-04T16:00:00Z'), startAt: null, doneAt: null, ownerId: 'r', workId: 'w1' }].filter((x) => where.ownerId.in.includes(x.ownerId)))
    const resolved = patch(t, prisma.user, 'findMany', async () => [roman])
    const text = await worksBrief({ id: 'lead', role: 'lead', departmentId: 'd' }, null, NOW)
    // Люди ищутся только среди своих: teamWhere руководителя и он сам.
    assert.deepEqual(resolved[0][0].where.AND[1].OR, [{ role: 'staff', active: true, departmentId: 'd', id: { not: 'lead' } }, { id: 'lead' }])
    assert.deepEqual(samples[0][0].where.ownerId, { in: ['r'] })
    assert.match(text, /открыто задач 5, в процессе 1, просрочено 2/)
    assert.match(text, /\n  \(Дизайн\) Роман, открыто 2/)
    assert.match(text, /\n  другие отделы, открыто 3, в процессе 1, просрочено 2\n/)
    assert.match(text, /\n  - \(Дизайн\) Роман, «Свой макет»/)
    assert.doesNotMatch(text, /Сотрудник|igor/)
    // «и ещё» считает только задачи видимых людей: его вторая, а чужие три уже в сумме.
    assert.match(text, /и ещё 1$/)
  })

  test('сотруднику работы не видны', async () => {
    assert.equal(await worksBrief({ role: 'staff' }, null, NOW), 'Работы в Иерархии тебе не видны.')
  })
})
