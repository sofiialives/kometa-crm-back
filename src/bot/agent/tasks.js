import { prisma } from '../../config/prisma.js'
import { escapeHtml } from '../telegram.js'
import { PARTICIPANT_ROLES } from '../../services/motivation/access.js'
import { mskDateStart } from '../../services/motivation/taskRules.js'
import { updateTaskStatus } from '../../services/task.service.js'
import { dueInMinutes, isQuietHour, isWorkday, mskDayKey } from '../plan.js'
import { activeAway, hasEndedDay } from './away.js'
import { hm, short } from './format.js'
import { crmButton, firstName, hasNotice, logEvent, nameOf, row, sendOnce, tell, tellOwners } from './notify.js'
import * as state from './state.js'

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
      `${escapeHtml(firstName(person.name))}, на сегодня у тебя в CRM нет задач.\nПроставь, пожалуйста, задачи на день 🙏`,
      { buttons: [row(crmButton('Открыть задачи', '/tasks'))].filter((r) => r.length) }))
    if (res.ok) sent += 1
  }
  return sent
}

/** Раз в минуту: задачи, которые начинаются через 5 минут. */
export async function tickTaskStarts(now = new Date()) {
  const from = new Date(now.getTime() + (TASK_START_BEFORE_MIN - 1) * 60000)
  const to = new Date(now.getTime() + TASK_START_BEFORE_MIN * 60000)
  const tasks = await prisma.task.findMany({
    where: { status: 'today', startAt: { gt: from, lte: to }, owner: { active: true, role: { in: PARTICIPANT_ROLES } } },
    select: { id: true, title: true, startAt: true, ownerId: true },
  })
  for (const task of tasks) {
    if (!dueInMinutes(task.startAt, now, TASK_START_BEFORE_MIN)) continue
    if ((await activeAway(task.ownerId, now)) || (await hasEndedDay(task.ownerId, now))) continue
    await sendOnce(`task-start:${task.id}:${task.startAt.getTime()}`, () => tell(task.ownerId,
      `Через 5 минут, в <b>${hm(task.startAt)}</b>, начинается задача\n«${escapeHtml(short(task.title, 120))}»\n\nКак начнёшь, нажми кнопку или перетащи её в «В процессе».`,
      { buttons: [taskButtons(task, false)] }))
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

const taskButtons = (task, many) => [
  { text: many ? `▶️ ${short(task.title, 24)}` : '▶️ Беру в работу', data: `tk:go:${task.id}` },
  { text: '⏳ Не успеваю', data: `tk:late:${task.id}` },
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
    select: { id: true, title: true, startAt: true, createdAt: true, ownerId: true, owner: { select: { id: true, name: true } } },
    orderBy: { startAt: 'asc' },
  })
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
    // Предыдущая сегодняшняя задача ещё в работе — цепочка 10–11, 11–12 не
    // повод для отчёта. Только сегодняшняя и со временем начала: забытая
    // в «В процессе» старая задача не должна глушить отчёты навсегда.
    const busy = await prisma.task.findFirst({
      where: { ownerId: userId, status: 'progress', startAt: { gte: mskDateStart(mskDayKey(now)), lt: group.startAt } },
      select: { id: true },
    })
    if (busy) continue
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
    const bullets = titles.map((t) => `• ${t}`).join('\n')
    const res = await sendOnce(key, () => tellOwners(many
      ? `⏰ <b>Задачи не начаты вовремя</b>\n${nameOf(group.owner)}\nПо плану в ${hm(group.startAt)}, прошло ${minutes} мин\n\n${bullets}`
      : `⏰ <b>Задача не начата вовремя</b>\n${nameOf(group.owner)}\n${titles[0]}\nПо плану в ${hm(group.startAt)}, прошло ${minutes} мин`))
    if (res.skipped) continue
    // Временный сбой — ключ освобождён, повторим на следующем проходе целиком.
    if (!res.ok && res.retry) continue
    for (const t of list) {
      await logEvent(userId, 'task_not_started', { at: now, data: { taskId: t.id, taskTitle: t.title, startAt: t.startAt.toISOString(), told: res.ok } })
    }
    await tell(userId,
      many
        ? `Эти задачи должны были начаться в <b>${hm(group.startAt)}</b>\n\n${bullets}\n\nКак дела?`
        : `Задача ${titles[0]} должна была начаться в <b>${hm(group.startAt)}</b>. Как дела?`,
      { buttons: list.slice(0, 5).map((t) => taskButtons(t, many)) })
  }
}

/**
 * Кнопка «Беру в работу»: задача уходит в «В процессе». Только из «На
 * сегодня»: кнопка живёт под сообщением, и нажатая вечером на закрытой
 * задаче она вернула бы её из «Готово» и сняла бы баллы за срок.
 */
export async function takeTask(user, taskId) {
  const task = await prisma.task.findUnique({ where: { id: taskId }, select: { title: true, status: true, ownerId: true } })
  if (!task || task.ownerId !== user.id) return 'Задача не найдена.'
  if (task.status === 'progress') return `«${escapeHtml(short(task.title, 120))}» уже в процессе.`
  if (task.status === 'done') return `«${escapeHtml(short(task.title, 120))}» уже закрыта 👍`
  try {
    // В журнал «взял в работу» запишет сам сервис задач.
    const task = await updateTaskStatus(taskId, 'progress', user)
    return `▶️ «${escapeHtml(short(task.title, 120))}» в процессе. Удачи!`
  } catch (e) {
    return e.status ? `Не получилось. ${e.message}` : 'Не получилось, открой задачу в CRM.'
  }
}

/** Кнопка «Не успеваю»: спрашиваем, что случилось, и ждём строку. */
export async function lateForTask(user, taskId) {
  const task = await prisma.task.findUnique({ where: { id: taskId }, select: { id: true, title: true, ownerId: true, status: true } })
  if (!task || task.ownerId !== user.id) return 'Задача не найдена.'
  if (task.status === 'done') return `«${escapeHtml(short(task.title, 120))}» уже закрыта 👍`
  state.expect(user.id, 'task_late', { taskId })
  await tell(user.id, 'Что случилось и во сколько начнёшь?\nНапиши одной строкой, я передам Яну.')
  return `⏳ Не успеваю начать «${escapeHtml(short(task.title, 120))}»`
}

/** Ответ на «что случилось?» — Яну. */
export async function reportTaskLate(user, taskId, text, now = new Date()) {
  const task = await prisma.task.findUnique({ where: { id: taskId }, select: { title: true, startAt: true } })
  await logEvent(user.id, 'task_late', { at: now, text, data: { taskId, taskTitle: task?.title ?? null, startAt: task?.startAt?.toISOString() ?? null } })
  await tell(user.id, 'Понял, передал Яну.')
  await tellOwners(`⏳ ${nameOf(user)} не успевает начать «${escapeHtml(short(task?.title || 'задачу', 120))}»${task?.startAt ? `\nПо плану в ${hm(task.startAt)}` : ''}\n<i>${escapeHtml(text.slice(0, 400))}</i>`)
}
