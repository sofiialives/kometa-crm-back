import { prisma } from '../../config/prisma.js'
import { escapeHtml } from '../telegram.js'
import { PARTICIPANT_ROLES } from '../../services/motivation/access.js'
import { mskDateStart } from '../../services/motivation/taskRules.js'
import { updateTaskStatus } from '../../services/task.service.js'
import { chargeNotStarted } from '../../services/motivation/autoTasks.service.js'
import { isQuietHour, isWorkday, mskDayKey } from '../plan.js'
import { nudgeText } from '../ai/nudge.js'
import { activeAway, hasEndedDay } from './away.js'
import { hm, short } from './format.js'
import { crmButton, firstName, hasNotice, logEvent, nameOf, row, sendOnce, tell, tellOwners } from './notify.js'
import * as state from './state.js'
import { dueTodayWhere, VISIBLE } from './taskScope.js'

/**
 * Задачи: утром — тем, у кого на сегодня пусто; за 5 минут до начала —
 * «перетащи в процесс». Не успевает — пишет боту, бот передаёт Яну.
 * Человека с меткой отлучки или форс-мажора не трогаем.
 */

const TASK_START_BEFORE_MIN = 5

/** 10:00 по будням: нет ни одной задачи со сроком на сегодня. */
export async function morningNoTasks(now = new Date()) {
  const day = mskDayKey(now)
  if (!isWorkday(day)) return 0
  const start = mskDateStart(day)
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000)

  const people = await prisma.user.findMany({
    where: {
      role: { in: PARTICIPANT_ROLES },
      active: true,
      telegram: { chatId: { not: null } },
      tasks: { none: { deadline: { gte: start, lt: end } } },
    },
    select: { id: true, name: true },
  })
  let sent = 0
  for (const person of people) {
    if (await activeAway(person.id, now)) continue
    const res = await sendOnce(`morning:${day}:${person.id}`, () => tell(person.id,
      `${escapeHtml(firstName(person.name))}, на сегодня у тебя в CRM нет задач\nПроставь, пожалуйста, задачи на день`,
      { buttons: [row(crmButton('Открыть задачи', '/tasks'))].filter((r) => r.length) }))
    if (res.ok) sent += 1
  }
  return sent
}

const EVENING_TITLES = 5

/**
 * Текст вечернего сообщения: названия до пяти, остальные «и ещё N». Без
 * точек, двоеточий и маркеров, как всё в боте.
 */
export function eveningText(name, titles, total) {
  const lines = [`${escapeHtml(firstName(name))}, через час звонок`, 'Осталось закрыть', ...titles.map((t) => `«${escapeHtml(short(t, 80))}»`)]
  if (total > titles.length) lines.push(`и ещё ${total - titles.length}`)
  return lines.join('\n')
}

/**
 * 18:00 по будням, за час до звонка: только тем, у кого остались незакрытые
 * задачи со сроком сегодня, личные и из Иерархии. Остальным не пишем, чтобы
 * сообщение не было одинаковым для всех. Без ИИ.
 */
export async function eveningOpenTasks(now = new Date()) {
  const day = mskDayKey(now)
  if (!isWorkday(day)) return 0
  const open = { AND: [VISIBLE, dueTodayWhere(now)] }
  const people = await prisma.user.findMany({
    where: { role: { in: PARTICIPANT_ROLES }, active: true, telegram: { chatId: { not: null } }, tasks: { some: open } },
    select: { id: true, name: true },
  })
  let sent = 0
  for (const person of people) {
    if ((await activeAway(person.id, now)) || (await hasEndedDay(person.id, now))) continue
    const where = { AND: [VISIBLE, { ownerId: person.id }, dueTodayWhere(now)] }
    const [tasks, total] = await Promise.all([
      prisma.task.findMany({ where, orderBy: { deadline: 'asc' }, take: EVENING_TITLES, select: { title: true } }),
      prisma.task.count({ where }),
    ])
    if (!total) continue
    const res = await sendOnce(`evening:${day}:${person.id}`, () => tell(person.id, eveningText(person.name, tasks.map((t) => t.title), total),
      { buttons: [row(crmButton('Открыть задачи', '/tasks'))].filter((r) => r.length) }))
    if (res.ok) sent += 1
  }
  return sent
}

/** Минута начала: 12:00:00 и 12:00:30 — одно время начала. */
export const startMinute = (date) => Math.floor(new Date(date).getTime() / 60000)

/** Задачи по человеку и минуте начала: на 12:00 их может быть несколько, сообщение одно. */
export function startGroups(tasks) {
  const groups = new Map()
  for (const task of tasks) {
    const key = `${task.ownerId}:${startMinute(task.startAt)}`
    if (!groups.has(key)) groups.set(key, { ownerId: task.ownerId, startAt: task.startAt, tasks: [] })
    groups.get(key).tasks.push(task)
  }
  return [...groups.values()]
}

/** Текст за 5 минут до начала: одна задача или все задачи этого времени. */
export function startText(group, now = null) {
  // Пропущенный проход мог сдвинуть напоминание: тогда не «через 5 минут», а «скоро».
  const left = now ? Math.ceil((group.startAt.getTime() - now.getTime()) / 60000) : TASK_START_BEFORE_MIN
  const lead = left >= TASK_START_BEFORE_MIN - 1 ? 'Через 5 минут' : 'Скоро'
  const titles = group.tasks.map((t) => `«${escapeHtml(short(t.title, 120))}»`)
  const time = `<b>${hm(group.startAt)}</b>`
  if (titles.length === 1) return `${lead}, в ${time}, начинается ${titles[0]}\nКак начнёшь, жми кнопку или перетащи её в «В процессе»`
  const shown = titles.slice(0, MAX_BUTTON_TASKS)
  const more = titles.length > shown.length ? [`и ещё ${titles.length - shown.length}`] : []
  return [`${lead}, в ${time}, начинаются задачи`, ...shown, ...more, 'Как начнёшь, жми кнопку или перетащи в «В процессе»'].join('\n')
}

/** Раз в минуту: задачи, которые начинаются через 5 минут, одним сообщением на человека и время. */
export async function tickTaskStarts(now = new Date()) {
  // Окно не в одну минуту, а все оставшиеся до начала 5 минут: если проход
  // пропустили (прошлый ещё шёл), напоминание придёт на следующем, а не потеряется.
  // Повтор исключает sendOnce.
  const to = new Date(now.getTime() + TASK_START_BEFORE_MIN * 60000)
  const tasks = await prisma.task.findMany({
    where: { status: 'today', startAt: { gt: now, lte: to }, owner: { active: true, role: { in: PARTICIPANT_ROLES } } },
    select: { id: true, title: true, startAt: true, ownerId: true },
    orderBy: { startAt: 'asc' },
  })
  for (const group of startGroups(tasks)) {
    // Тихие часы 21–9 считаем по времени начала: задача на 9:00 получает
    // напоминание в 8:55, а задача на 21:00 не получает его в 20:55.
    if (isQuietHour(group.startAt)) continue
    if ((await activeAway(group.ownerId, now)) || (await hasEndedDay(group.ownerId, now))) continue
    await sendOnce(`task-start:${group.ownerId}:${startMinute(group.startAt)}`, () => tell(group.ownerId, startText(group, now),
      { buttons: taskButtons(group.tasks) }))
  }
}

// Через сколько минут после начала, если задачу не взяли в работу, бот
// сам спрашивает человека и сообщает Яну. Окно — полчаса: пропущенный
// проход или временный сбой телеграма отчёт не теряют, повторов не даёт
// sendOnce.
const NOT_STARTED_AFTER_MIN = 15
const NOT_STARTED_WINDOW_MIN = 30
// Сказал «задерживаюсь до 11:30» — до 11:45 не трогаем; «опаздываю» без
// времени — три часа.
const LATE_GRACE_MS = 15 * 60000
const LATE_NO_TIME_MS = 3 * 60 * 60000

// Сколько задач с отдельной кнопкой «Беру» в одном сообщении.
const MAX_BUTTON_TASKS = 5

/** По кнопке «Беру» на каждую задачу (до пяти) и одна «Не успеваю» на всё время начала. */
export const taskButtons = (tasks) => [
  ...tasks.slice(0, MAX_BUTTON_TASKS).map((t) => [{ text: tasks.length > 1 ? `Беру ${short(t.title, 24)}` : 'Беру в работу', data: `tk:go:${t.id}` }]),
  [{ text: 'Не успеваю', data: `tk:late:${tasks[0].id}` }],
]

/** Человек сам предупредил о задержке, и срок ещё не вышел. */
export function excusedByLate(lates, now) {
  return lates.some((e) => {
    const until = e.data?.until ? new Date(e.data.until).getTime() : null
    return until ? until + LATE_GRACE_MS > now.getTime() : now.getTime() - new Date(e.at).getTime() < LATE_NO_TIME_MS
  })
}

/**
 * Задачи по людям и времени начала: пять задач на 10:00 — одно сообщение,
 * а не пять. Задачи, заведённые уже после начала (задним числом), не берём:
 * их и не могли начать вовремя.
 */
export function notStartedGroups(tasks) {
  const groups = new Map()
  for (const task of tasks) {
    if (task.createdAt && task.createdAt.getTime() > task.startAt.getTime()) continue
    const key = `${task.ownerId}:${task.startAt.getTime()}`
    if (!groups.has(key)) groups.set(key, { key, ownerId: task.ownerId, owner: task.owner, startAt: task.startAt, tasks: [] })
    groups.get(key).tasks.push(task)
  }
  return [...groups.values()]
}

/** Шаблонный вопрос, когда агент недоступен. */
export function notStartedText(tasks, startAt) {
  const titles = tasks.map((t) => `«${escapeHtml(short(t.title, 120))}»`)
  const time = `<b>${hm(startAt)}</b>`
  return titles.length > 1
    ? `Эти задачи должны были начаться в ${time}\n${titles.join('\n')}\nКак дела?`
    : `${titles[0]} должна была начаться в ${time}\nКак дела?`
}

/** Взял в работу хоть одну задачу этого времени или сейчас есть задача в процессе. */
async function isWorking(ownerId, startAt, now) {
  const dayStart = mskDateStart(mskDayKey(now))
  const busy = await prisma.task.findFirst({
    where: {
      ownerId,
      OR: [
        { startAt, status: { in: ['progress', 'done'] } },
        { status: 'progress', OR: [{ startAt: { gte: dayStart } }, { updatedAt: { gte: dayStart } }] },
      ],
    },
    select: { id: true },
  })
  return Boolean(busy)
}

/**
 * Раз в минуту: задача должна была начаться 15+ минут назад, а она всё ещё
 * «На сегодня». Человеку — вопрос с кнопками, Яну — отчёт. Не трогаем, если
 * у человека нет бота, он сказал «не успеваю» или «задерживаюсь», отошёл,
 * у него форс-мажор, он закончил день или ещё ведёт предыдущую задачу.
 * Ночью не пишем.
 */
export async function tickNotStarted(now = new Date()) {
  if (isQuietHour(now)) return
  const from = new Date(now.getTime() - (NOT_STARTED_AFTER_MIN + NOT_STARTED_WINDOW_MIN) * 60000)
  const to = new Date(now.getTime() - NOT_STARTED_AFTER_MIN * 60000)
  const tasks = await prisma.task.findMany({
    where: {
      status: 'today',
      startAt: { gt: from, lte: to },
      owner: { active: true, role: { in: PARTICIPANT_ROLES }, telegram: { chatId: { not: null } } },
    },
    select: { id: true, title: true, description: true, deadline: true, origin: true, startAt: true, createdAt: true, ownerId: true, owner: { select: { id: true, name: true, role: true } } },
    orderBy: { startAt: 'asc' },
  })
  const jobs = []
  for (const group of notStartedGroups(tasks)) {
    const key = `task-nostart:${group.key}`
    if (await hasNotice(key)) continue
    const userId = group.ownerId
    if ((await activeAway(userId, now)) || (await hasEndedDay(userId, now))) continue
    const lates = await prisma.botEvent.findMany({
      where: { userId, type: 'late', at: { gte: new Date(now.getTime() - 12 * 60 * 60000) } },
      select: { at: true, data: true },
    })
    if (excusedByLate(lates, now)) continue
    // Человек уже работает: взял в работу хоть одну задачу этой группы или у
    // него сейчас что-то в процессе. Тогда ни вопроса, ни отчёта Яну, ни
    // баллов за остальные. Забытая в «В процессе» старая задача не в счёт:
    // считаем только ту, к которой сегодня прикасались.
    if (await isWorking(userId, group.startAt, now)) continue
    const warned = await prisma.botEvent.findMany({
      where: { userId, type: 'task_late', OR: group.tasks.map((t) => ({ data: { path: ['taskId'], equals: t.id } })) },
      select: { data: true },
    })
    const warnedIds = new Set(warned.map((e) => e.data?.taskId))
    const list = group.tasks.filter((t) => !warnedIds.has(t.id))
    if (!list.length) continue

    const minutes = Math.round((now.getTime() - group.startAt.getTime()) / 60000)
    const titles = list.map((t) => `«${escapeHtml(short(t.title, 120))}»`)
    const many = list.length > 1
    const res = await sendOnce(key, () => tellOwners(`<b>${many ? 'Задачи не начаты вовремя' : 'Задача не начата вовремя'}</b>\n${nameOf(group.owner)}\n${titles.join('\n')}\nПо плану в ${hm(group.startAt)}, прошло ${minutes} мин`))
    if (res.skipped) continue
    // Временный сбой — ключ освобождён, повторим на следующем проходе целиком.
    if (!res.ok && res.retry) continue
    for (const t of list) {
      await logEvent(userId, 'task_not_started', { at: now, data: { taskId: t.id, taskTitle: t.title, startAt: t.startAt.toISOString(), told: res.ok } })
      // Баллы по событию «Задача не начата вовремя», если оно есть в профиле:
      // сразу или заявкой владельцу. Сбой баллов не должен сорвать сообщения.
      await chargeNotStarted(t, now).catch((e) => console.error('[бот] баллы за неначатую задачу:', e.message))
    }
    jobs.push({ userId, owner: group.owner, list, startAt: group.startAt, minutes })
  }
  await askAll(jobs, now)
}

// Вопросы агента не должны держать минутный проход: не больше трёх людей
// сразу, на каждого ~10 секунд, на все вместе ~20, потом сразу шаблон.
const NUDGE_PARALLEL = 3
const NUDGE_EACH_MS = 10_000
const NUDGE_TOTAL_MS = 20_000

const timeoutAfter = (ms) => new Promise((resolve) => { setTimeout(() => resolve(null), ms).unref?.() })

/**
 * Отправить вопросы о неначатых задачах. Текст пишет агент; не ответил
 * вовремя, сбой, лимит или бюджет кончился — уходит шаблон. deps.nudge
 * подменяет запрос к агенту в проверках.
 */
export async function askAll(jobs, now = new Date(), deps = {}) {
  const ask = deps.nudge ?? nudgeText
  const deadline = Date.now() + (deps.totalMs ?? NUDGE_TOTAL_MS)
  const queue = [...jobs]
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const left = deadline - Date.now()
      const text = left > 1000
        ? await Promise.race([
          Promise.resolve(ask({ user: job.owner, titles: job.list.map((t) => t.title), startAt: job.startAt, minutes: job.minutes, now, timeoutMs: Math.min(deps.eachMs ?? NUDGE_EACH_MS, left) })).catch(() => null),
          timeoutAfter(Math.min(deps.eachMs ?? NUDGE_EACH_MS, left)),
        ])
        : null
      await tell(job.userId, text ? escapeHtml(text) : notStartedText(job.list, job.startAt), { buttons: taskButtons(job.list) })
        .catch((e) => console.error('[бот] вопрос о неначатых задачах:', e.message))
    }
  }
  await Promise.all(Array.from({ length: Math.min(deps.parallel ?? NUDGE_PARALLEL, jobs.length) }, worker))
}

/**
 * Кнопка «Беру в работу»: задача уходит в «В процессе». Только из «На
 * сегодня»: кнопка живёт под сообщением, и нажатая вечером на закрытой
 * задаче она вернула бы её из «Готово» и сняла бы баллы за срок.
 */
export async function takeTask(user, taskId) {
  const task = await prisma.task.findUnique({ where: { id: taskId }, select: { title: true, status: true, ownerId: true } })
  if (!task || task.ownerId !== user.id) return 'Задача не найдена'
  if (task.status === 'progress') return `«${escapeHtml(short(task.title, 120))}» уже в процессе`
  if (task.status === 'done') return `«${escapeHtml(short(task.title, 120))}» уже закрыта`
  try {
    // В журнал «взял в работу» запишет сам сервис задач.
    const task = await updateTaskStatus(taskId, 'progress', user)
    return `«${escapeHtml(short(task.title, 120))}» в процессе`
  } catch (e) {
    return e.status ? `Не получилось\n${e.message}` : 'Не получилось, открой задачу в CRM'
  }
}

/**
 * Кнопка «Не успеваю»: спрашиваем, что случилось, и ждём строку. Она одна
 * на всё время начала, поэтому «не успеваю» относится ко всем ещё не
 * начатым задачам этого времени.
 */
export async function lateForTask(user, taskId) {
  const task = await prisma.task.findUnique({ where: { id: taskId }, select: { id: true, title: true, ownerId: true, status: true, startAt: true } })
  if (!task || task.ownerId !== user.id) return 'Задача не найдена'
  if (task.status === 'done') return `«${escapeHtml(short(task.title, 120))}» уже закрыта`
  const where = { ownerId: user.id, status: 'today', startAt: task.startAt }
  const total = task.startAt ? await prisma.task.count({ where }) : 0
  const same = task.startAt
    ? await prisma.task.findMany({ where: { ownerId: user.id, status: 'today', startAt: task.startAt }, orderBy: { createdAt: 'asc' }, take: MAX_BUTTON_TASKS, select: { id: true } })
    : []
  const taskIds = [...new Set([task.id, ...same.map((t) => t.id)])].slice(0, MAX_BUTTON_TASKS)
  state.expect(user.id, 'task_late', { taskId, taskIds, total: Math.max(total, taskIds.length) })
  await tell(user.id, 'Что случилось и во сколько начнёшь?\nНапиши одной строкой, я передам Яну')
  return taskIds.length > 1 ? 'Не успеваю начать' : `Не успеваю начать «${escapeHtml(short(task.title, 120))}»`
}

/** Ответ на «что случилось?» — Яну. taskIds — задачи этого времени начала (не больше пяти), total — сколько их всего. */
export async function reportTaskLate(user, taskId, text, now = new Date(), taskIds = [taskId], total = taskIds.length) {
  const ids = [...new Set(taskIds)].slice(0, MAX_BUTTON_TASKS)
  const found = await prisma.task.findMany({ where: { id: { in: ids }, ownerId: user.id }, take: MAX_BUTTON_TASKS, select: { id: true, title: true, startAt: true } })
  const list = found.length ? found : [{ id: taskId, title: null, startAt: null }]
  for (const task of list) {
    await logEvent(user.id, 'task_late', { at: now, text, data: { taskId: task.id, taskTitle: task.title ?? null, startAt: task.startAt?.toISOString() ?? null } })
  }
  await tell(user.id, 'Понял, передал Яну')
  const titles = list.map((t) => `«${escapeHtml(short(t.title || 'задача', 120))}»`)
  const more = total > list.length ? [`и ещё ${total - list.length}`] : []
  const startAt = list.find((t) => t.startAt)?.startAt
  await tellOwners(`<b>${list.length > 1 ? 'Не успевает начать задачи' : 'Не успевает начать задачу'}</b>\n${nameOf(user)}\n${[...titles, ...more].join('\n')}${startAt ? `\nПо плану в ${hm(startAt)}` : ''}\n<i>${escapeHtml(text.slice(0, 400))}</i>`)
}
