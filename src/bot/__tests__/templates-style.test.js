import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { buildReminder } from '../reminders.js'
import { bankLine, eventLine, reviewText } from '../agent/feed.js'
import { confirmText, draftText, reportText } from '../agent/rounds.js'
import { eveningText, notStartedText, startText } from '../agent/tasks.js'
import { DAILY } from '../index.js'
import { limitText } from '../ai/agent.js'

const T = new Date('2026-11-03T09:00:00Z')

/** Шаблон в стиле бота: без маркеров, точек в конце строк, двоеточий, скобок, восклицаний и смайликов. */
function assertPlain(text, what) {
  const clean = String(text).replace(/<[^>]+>/g, '')
  assert.doesNotMatch(clean, /•/, `${what}: маркер`)
  assert.doesNotMatch(clean, /!/, `${what}: восклицание`)
  assert.doesNotMatch(clean, /[()]/, `${what}: скобки`)
  assert.doesNotMatch(clean, /\p{Extended_Pictographic}/u, `${what}: смайлик`)
  assert.doesNotMatch(clean, /(^|[^\d]):|:(?!\d)/, `${what}: двоеточие`)
  assert.doesNotMatch(clean, /(?<!\.)\.[ \t]*$/m, `${what}: точка в конце строки`)
  assert.doesNotMatch(clean, /весь\/вся|\(а\)|ая\)/, `${what}: «весь/вся»`)
}

describe('шаблоны бота в новом стиле', () => {
  test('расписание, вечер, начало задач, неначатые задачи', () => {
    for (const d of DAILY) assertPlain(d.text, 'расписание')
    assertPlain(eveningText('Антон', ['Макет', 'Баннер'], 7), 'вечер')
    const tasks = [{ id: 'a', title: 'Макет' }, { id: 'b', title: 'Баннер' }]
    assertPlain(startText({ startAt: T, tasks }), 'начало задач')
    assertPlain(startText({ startAt: T, tasks: tasks.slice(0, 1) }), 'начало задачи')
    assertPlain(notStartedText(tasks, T), 'неначатые')
    assertPlain(notStartedText(tasks.slice(0, 1), T), 'неначатая')
  })

  test('напоминание о звонке', () => {
    const call = { title: 'Планёрка', scheduledAt: T, note: null, ownerId: 'o' }
    assertPlain(buildReminder(call, { id: 'u', name: 'Антон Иванов' }, [{ id: 'u', name: 'Антон' }, { id: 'o', name: 'Ян' }], 15), 'звонок')
  })

  test('баллы, банк, заявка', () => {
    assertPlain(eventLine({ eventType: { systemKey: 'checkin_missed' }, prizePoints: -3 }), 'чек-ин')
    assertPlain(eventLine({ eventType: { systemKey: 'call_missed' }, prizePoints: -2 }), 'звонок пропущен')
    assertPlain(bankLine({ kind: 'start', amountCents: 10000 }), 'банк')
    assertPlain(reviewText({ user: { name: 'Роман' }, rule: 'task_on_time', taskTitle: 'Макет', complexity: 'medium', prizePoints: 2 }), 'заявка')
  })

  test('поручение, черновик и отчёт Яну', () => {
    assertPlain(draftText({ people: [{ label: 'Роман, дизайн', text: 'Роман, как макет' }], skipped: ['Настя, SEO, телеграм не подключён'] }), 'черновик')
    assertPlain(confirmText({ topic: 'Как дела', collect: true, deadlineAt: T, count: 2, links: ['evil.com/x'], unchecked: true }), 'подтверждение')
    const answered = [{ userId: 'a', label: 'Роман, дизайн', summary: 'Делает', messages: [{ direction: 'in', text: 'Делаю', createdAt: T, fileId: 'f' }] }]
    const text = reportText({
      round: { topic: 'Как дела', sentAt: T },
      answered,
      silent: [{ userId: 'b', label: 'Настя, SEO' }],
      failed: [{ userId: 'c', label: 'Олег, SMM' }],
      skipped: [{ userId: 'd', label: 'Денис, SMM' }],
      ai: { a: { points: ['Делает баннер, готов наполовину', '- ждёт правки (от клиента)!'], quote: 'Делаю' } },
      states: new Map([['a', { named: [{ title: 'Баннер', state: 'в процессе' }], summary: 'x' }]]),
    })
    assertPlain(text, 'отчёт')
    assert.match(text, /^<b>Отчёт по опросу<\/b>\nКак дела\nОтветили 1 из 2, написал в 12:00\n\n<b>Роман, дизайн<\/b>\nДелает баннер, готов наполовину\nждёт правки, от клиента\n<i>«Делаю»<\/i>/)
    assert.match(text, /<b>Не ответили<\/b> Настя, SEO; Олег, SMM, сообщение не дошло$/)
  })

  test('лимиты ИИ', () => {
    for (const status of [{ status: 'limit' }, { status: 'budget', why: 'month' }]) {
      assertPlain(limitText(status, false), 'лимит')
      assertPlain(limitText(status, true), 'лимит владельцу')
    }
  })
})
