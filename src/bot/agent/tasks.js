import { prisma } from '../../config/prisma.js'
import { escapeHtml } from '../telegram.js'
import { PARTICIPANT_ROLES } from '../../services/motivation/access.js'
import { mskDateStart } from '../../services/motivation/taskRules.js'
import { updateTaskStatus } from '../../services/task.service.js'
import { dueInMinutes, isQuietHour, isWorkday, mskDayKey } from '../plan.js'
import { activeAway, hasEndedDay } from './away.js'
import { hm, short } from './format.js'
import { crmButton, firstName, logEvent, nameOf, row, sendOnce, tell, tellOwners } from './notify.js'
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
      `${escapeHtml(firstName(person.name))}, на сегодня у тебя в CRM нет ни одной задачи со сроком на сегодня. Проставь, пожалуйста, задачи на день 🙏`,
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
      `Через 5 минут, в <b>${hm(task.startAt)}</b>, начинается задача\n«${escapeHtml(short(task.title, 120))}»\n\nКак начнёшь — перетащи её в «В процессе».`,
      { buttons: [[{ text: '▶️ Беру в работу', data: `tk:go:${task.id}` }, { text: '⏳ Не успеваю', data: `tk:late:${task.id}` }]] }))
  }
}

// Через сколько минут после начала, если задачу не взяли в работу, бот
// сам спрашивает человека и сообщает Яну.
const NOT_STARTED_AFTER_MIN = 15

/**
 * Раз в минуту: задача должна была начаться 15 минут назад, а она всё ещё
 * «На сегодня». Человеку — вопрос с кнопками, Яну — отчёт. Не трогаем, если
 * человек уже сказал «не успеваю», отошёл, у него форс-мажор или он
 * закончил день. Ночью не пишем.
 */
export async function tickNotStarted(now = new Date()) {
  if (isQuietHour(now)) return
  const from = new Date(now.getTime() - (NOT_STARTED_AFTER_MIN + 1) * 60000)
  const to = new Date(now.getTime() - NOT_STARTED_AFTER_MIN * 60000)
  const tasks = await prisma.task.findMany({
    where: { status: 'today', startAt: { gt: from, lte: to }, owner: { active: true, role: { in: PARTICIPANT_ROLES } } },
    select: { id: true, title: true, startAt: true, ownerId: true, owner: { select: { id: true, name: true } } },
  })
  for (const task of tasks) {
    if ((await activeAway(task.ownerId, now)) || (await hasEndedDay(task.ownerId, now))) continue
    const warned = await prisma.botEvent.findFirst({
      where: { userId: task.ownerId, type: 'task_late', data: { path: ['taskId'], equals: task.id } },
      select: { id: true },
    })
    if (warned) continue
    const res = await sendOnce(`task-nostart:${task.id}:${task.startAt.getTime()}`, () =>
      tellOwners(`⏰ ${nameOf(task.owner)} не начал(а) задачу «${escapeHtml(short(task.title, 120))}» — по плану в ${hm(task.startAt)}, прошло ${NOT_STARTED_AFTER_MIN} минут.`))
    if (res.skipped) continue
    await logEvent(task.ownerId, 'task_not_started', { at: now, data: { taskId: task.id, taskTitle: task.title, startAt: task.startAt.toISOString() } })
    await tell(task.ownerId,
      `Задача «${escapeHtml(short(task.title, 120))}» должна была начаться в <b>${hm(task.startAt)}</b>. Как дела?`,
      { buttons: [[{ text: '▶️ Беру в работу', data: `tk:go:${task.id}` }, { text: '⏳ Не успеваю', data: `tk:late:${task.id}` }]] })
  }
}

/**
 * Кнопка «Беру в работу»: задача уходит в «В процессе». Только из «На
 * сегодня»: кнопка живёт под сообщением, и нажатая вечером на закрытой
 * задаче она вернула бы её из «Готово» и сняла бы баллы за срок.
 */
export async function takeTask(user, taskId, now = new Date()) {
  const task = await prisma.task.findUnique({ where: { id: taskId }, select: { title: true, status: true, ownerId: true } })
  if (!task || task.ownerId !== user.id) return 'Задача не найдена.'
  if (task.status === 'progress') return `«${escapeHtml(short(task.title, 120))}» уже в процессе.`
  if (task.status === 'done') return `«${escapeHtml(short(task.title, 120))}» уже закрыта 👍`
  try {
    // В журнал «взял в работу» запишет сам сервис задач.
    const task = await updateTaskStatus(taskId, 'progress', user)
    return `▶️ «${escapeHtml(short(task.title, 120))}» — в процессе. Удачи!`
  } catch (e) {
    return e.status ? `Не получилось: ${e.message}` : 'Не получилось — открой задачу в CRM.'
  }
}

/** Кнопка «Не успеваю»: спрашиваем, что случилось, и ждём строку. */
export async function lateForTask(user, taskId) {
  const task = await prisma.task.findUnique({ where: { id: taskId }, select: { id: true, title: true, ownerId: true, status: true } })
  if (!task || task.ownerId !== user.id) return 'Задача не найдена.'
  if (task.status === 'done') return `«${escapeHtml(short(task.title, 120))}» уже закрыта 👍`
  state.expect(user.id, 'task_late', { taskId })
  await tell(user.id, 'Что случилось и во сколько начнёшь? Напиши одной строкой — передам Яну.')
  return `⏳ «${escapeHtml(short(task.title, 120))}» — не успеваешь.`
}

/** Ответ на «что случилось?» — Яну. */
export async function reportTaskLate(user, taskId, text, now = new Date()) {
  const task = await prisma.task.findUnique({ where: { id: taskId }, select: { title: true, startAt: true } })
  await logEvent(user.id, 'task_late', { at: now, text, data: { taskId, taskTitle: task?.title ?? null, startAt: task?.startAt?.toISOString() ?? null } })
  await tell(user.id, 'Понял, передал Яну.')
  await tellOwners(`⏳ ${nameOf(user)} не успевает начать «${escapeHtml(short(task?.title || 'задачу', 120))}»${task?.startAt ? ` (по плану в ${hm(task.startAt)})` : ''}:\n«${escapeHtml(text.slice(0, 400))}»`)
}
