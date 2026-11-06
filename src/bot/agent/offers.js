import { prisma } from '../../config/prisma.js'
import { createTask } from '../../services/task.service.js'
import { escapeHtml } from '../telegram.js'
import { mskDayKey, mskDayStart, mskHour } from '../plan.js'
import { noLinks, plainStyle } from '../ai/style.js'
import { labelOf, personInScope } from '../ai/context.js'
import { cut, plain } from '../ai/limits.js'
import { dateShort, hm } from './format.js'
import { chatOf, tell, tellChat } from './notify.js'

/**
 * Задача по просьбе Яна или руководителя: «поставь Ивану задачу сделать
 * баннер до завтра 12:00». Агент ничего не создаёт: он готовит карточку
 * (BotTaskOffer) с кнопками «Поставить» и «Отмена». Задачу создаёт тот же
 * createTask, что и CRM, от имени просящего и только по кнопке. Права
 * проверяются и при карточке, и при нажатии: пользователя читаем из базы
 * заново.
 */

const HOUR = 60 * 60 * 1000
// Карточка без решения дольше трёх часов устарела.
export const OFFER_TTL_MS = 3 * HOUR
export const OFFERS_PER_DAY = 30
export const OFFERS_HANGING_MAX = 3
export const TITLE_MAX = 200
const DESCRIPTION_MAX = 300
// Захваченная кнопкой карточка, которая так и не закончилась, — подозрительна.
const CREATING_STUCK_MS = 2 * 60 * 1000
const NOTE_MAX = 500
// Срок по умолчанию: сегодня до 19:00, а после 18:00 завтра до 19:00.
const DEFAULT_DUE_H = 19
const LATE_FROM_H = 18
const MAX_AHEAD_MS = 366 * 24 * HOUR
const WHO = { select: { id: true, name: true, role: true, active: true, departmentId: true, department: { select: { name: true } } } }

/** Работа, доступная просящему: активная, а у руководителя только своего отдела. */
function workFor(user, workId) {
  return prisma.work.findFirst({
    where: { id: String(workId), status: 'active', ...(user.role === 'lead' ? { departmentId: user.departmentId ?? '__none__' } : {}) },
    select: { id: true, title: true, status: true, client: { select: { name: true } } },
  })
}

const BUTTONS = (id) => [[{ text: 'Поставить', data: `ta:go:${id}` }, { text: 'Отмена', data: `ta:no:${id}` }]]

/** Срок, если не назвали: сегодня до 19:00 по Москве, с 18:00 завтра до 19:00. */
export function defaultDeadline(now = new Date()) {
  const today = mskDayStart(mskDayKey(now))
  const day = mskHour(now) >= LATE_FROM_H ? new Date(today.getTime() + 24 * HOUR) : today
  return new Date(day.getTime() + DEFAULT_DUE_H * HOUR)
}

/**
 * Время из ISO. Без пояса считаем московским, только дата, то 19:00 того дня.
 * undefined — не разобрать.
 */
export function parseMsk(value) {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(String(value ?? '').trim())
  if (!m) return undefined
  const date = new Date(`${m[1]}T${m[2] ?? `${DEFAULT_DUE_H}:00`}:00${m[3]?.toUpperCase() ?? '+03:00'}`.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))
  return Number.isNaN(date.getTime()) ? undefined : date
}

/** Срок словами. on true: «на сегодня до 19:00», иначе «сегодня до 19:00». */
export function dueText(deadline, now = new Date(), { on = false } = {}) {
  const key = mskDayKey(deadline)
  const prefix = on ? 'на ' : ''
  if (key === mskDayKey(now)) return `${prefix}сегодня до ${hm(deadline)}`
  if (key === mskDayKey(new Date(now.getTime() + 24 * HOUR))) return `${prefix}завтра до ${hm(deadline)}`
  return `${dateShort(deadline)} до ${hm(deadline)}`
}

/** Время начала словами: «сегодня в 14:00», «завтра в 10:00» или дата. */
export function startText(startAt, now = new Date()) {
  const key = mskDayKey(startAt)
  if (key === mskDayKey(now)) return `сегодня в ${hm(startAt)}`
  if (key === mskDayKey(new Date(now.getTime() + 24 * HOUR))) return `завтра в ${hm(startAt)}`
  return `${dateShort(startAt)} в ${hm(startAt)}`
}

const workLine = (work) => (work ? `По работе, клиент ${plain(work.client?.name, 60)}, ${plain(work.title, 80)}` : 'Личная задача на день')

/** Карточка для просящего. */
export function offerText({ assignee, title, description, deadline, startAt = null, work, note, now = new Date() }) {
  const lines = [
    '<b>Поставить задачу</b>',
    `<b>${escapeHtml(labelOf(assignee))}</b>`,
    `«${escapeHtml(title)}»`,
    `Срок ${escapeHtml(dueText(deadline, now))}`,
    escapeHtml(workLine(work)),
  ]
  if (startAt) lines.splice(4, 0, `Начало ${escapeHtml(startText(startAt, now))}`)
  if (description) lines.push(`Описание ${escapeHtml(description)}`)
  if (note) lines.push(`Сообщение исполнителю ${escapeHtml(note)}`)
  lines.push('Поставить?')
  return lines.join('\n')
}

/** Сообщение исполнителю. */
export function assigneeText({ requester, title, deadline, work, note, now = new Date() }) {
  const from = requester.role === 'admin' ? 'Яна' : `руководителя ${labelOf(requester)}`
  const lines = [`Новая задача от ${from}`, `«${noLinks(plainStyle(title))}»`, `Срок ${dueText(deadline, now, { on: true })}`]
  if (work) lines.push(`Клиент ${plain(work.client?.name, 60)}, работа ${plain(work.title, 80)}`)
  if (note) lines.push(note)
  return lines.map((l) => escapeHtml(l)).join('\n')
}

/** Слова агента исполнителю в стиле бота, без ссылок. */
const cleanNote = (note) => noLinks(plainStyle(cut(String(note ?? '').trim(), NOTE_MAX)))

/** Честная короткая фраза для модели или карточки из ошибки CRM. */
export function reasonOf(e) {
  return e?.status ? plainStyle(plain(e.message, 200)) : 'не получилось, открой CRM'
}

/**
 * Предложить задачу. Ничего не создаёт, только карточка с кнопками.
 * Возвращает { shown, text }: показана ли карточка и текст для модели.
 */
export async function proposeTask(user, chatId, input, now = new Date()) {
  if (!['admin', 'lead'].includes(user?.role)) return { shown: false, text: 'Ставить задачи другим могут только Ян и руководитель отдела. Скажи об этом коротко.' }
  const assignee = await personInScope(user, input.person_id)
  if (!assignee) return { shown: false, text: 'Такого человека нет или он не в твоём отделе. Задачу не создавал, скажи об этом коротко.' }

  const title = plain(String(input.title ?? ''), TITLE_MAX).trim()
  if (!title) return { shown: false, text: 'Нет названия задачи. Спроси, что именно поставить.' }
  // plain: без невидимых символов и переводов строк, как у названия: описание пишет модель.
  const description = cut(noLinks(plainStyle(plain(String(input.description ?? ''), DESCRIPTION_MAX))), DESCRIPTION_MAX).trim() || null

  let deadline = defaultDeadline(now)
  if (input.deadline) {
    const parsed = parseMsk(input.deadline)
    if (!parsed) return { shown: false, text: 'Срок не разобрал. Нужен ISO по Москве, например 2026-11-07T12:00. Ничего не создавал.' }
    if (parsed.getTime() <= now.getTime()) return { shown: false, text: 'Срок уже в прошлом. Ничего не создавал, попроси уточнить срок.' }
    if (parsed.getTime() - now.getTime() > MAX_AHEAD_MS) return { shown: false, text: 'Срок дальше года, похоже на ошибку. Ничего не создавал, попроси уточнить срок.' }
    deadline = parsed
  }
  let startAt = null
  if (input.start_at) {
    startAt = parseMsk(input.start_at)
    if (!startAt) return { shown: false, text: 'Время начала не разобрал. Нужен ISO по Москве. Ничего не создавал.' }
    if (startAt.getTime() > deadline.getTime()) return { shown: false, text: 'Начало позже срока. Ничего не создавал, уточни время.' }
  }

  let work = null
  const workId = String(input.work_id ?? '').trim()
  if (workId) {
    work = await workFor(user, workId)
    if (!work) return { shown: false, text: 'Такой работы у тебя нет. id берётся из get_works. Ничего не создавал.' }
    if (user.role === 'admin' && assignee.id === user.id) return { shown: false, text: 'Задачу по работе нельзя поставить себе, нужен сотрудник.' }
  }

  const dayStart = mskDayStart(mskDayKey(now))
  const [today, hanging] = await Promise.all([
    prisma.botTaskOffer.count({ where: { requesterId: user.id, createdAt: { gte: dayStart } } }),
    prisma.botTaskOffer.count({ where: { requesterId: user.id, status: 'draft', createdAt: { gt: new Date(now.getTime() - OFFER_TTL_MS) } } }),
  ])
  if (today >= OFFERS_PER_DAY) return { shown: false, text: `На сегодня лимит ${OFFERS_PER_DAY} предложений задач исчерпан. Скажи об этом коротко.` }
  if (hanging >= OFFERS_HANGING_MAX) return { shown: false, text: `Уже висит ${hanging} карточек без решения. Пусть сначала нажмут «Поставить» или «Отмена» под ними. Скажи об этом коротко.` }

  const note = cleanNote(input.note) || null
  const offer = await prisma.botTaskOffer.create({
    data: { requesterId: user.id, assigneeId: assignee.id, title, description, deadline, startAt, workId: work?.id ?? null, note },
  })
  const shown = await tellChat(chatId, offerText({ assignee, title, description, deadline, startAt, work, note, now }), { userId: user.id, buttons: BUTTONS(offer.id) })
  if (!shown.ok) {
    await prisma.botTaskOffer.update({ where: { id: offer.id }, data: { status: 'cancelled', decidedAt: now } })
    return { shown: false, text: 'Карточка не отправилась, сбой телеграма. Скажи, чтобы попробовали ещё раз.' }
  }
  return { shown: true, text: 'Показана карточка с кнопками «Поставить» и «Отмена», задача пока не создана. Ничего больше не пиши.' }
}

/**
 * Кнопка под карточкой: go ставит задачу, иначе отмена. Нажать может
 * только тот, кто просил. Права проверяем заново по свежим данным из базы.
 * create подменяется в тестах. Возвращает строку, которую дописать под карточкой.
 */
export async function decideOffer(user, offerId, go, now = new Date(), { create = createTask } = {}) {
  const offer = await prisma.botTaskOffer.findUnique({ where: { id: String(offerId ?? '') } })
  if (!offer || offer.requesterId !== user.id) return 'Это не твоя карточка'
  if (offer.status !== 'draft') return statusText(offer, now)
  // Закрыть карточку как отменённую. Не удалось, значит её уже решили иначе: говорим как есть.
  const settle = async (message) => {
    const done = await prisma.botTaskOffer.updateMany({ where: { id: offer.id, status: 'draft' }, data: { status: 'cancelled', decidedAt: now } })
    if (done.count) return message
    return statusText(await prisma.botTaskOffer.findUnique({ where: { id: offer.id } }), now)
  }
  if (now - offer.createdAt > OFFER_TTL_MS) return settle('Карточка устарела, попроси ещё раз')
  if (!go) return settle('Отменено, задачу не ставил')
  if (offer.deadline.getTime() <= now.getTime()) return settle('Срок уже прошёл, попроси ещё раз')

  const requester = await prisma.user.findUnique({ where: { id: user.id }, ...WHO })
  if (!requester?.active || !['admin', 'lead'].includes(requester.role)) return settle('Не поставил, у тебя больше нет прав ставить задачи')
  // Двойное нажатие не создаст две задачи: из черновика выводит только один.
  const claimed = await prisma.botTaskOffer.updateMany({ where: { id: offer.id, status: 'draft' }, data: { status: 'creating', decidedAt: now } })
  if (!claimed.count) return statusText(await prisma.botTaskOffer.findUnique({ where: { id: offer.id } }), now)
  const fail = async (reason) => {
    await prisma.botTaskOffer.updateMany({ where: { id: offer.id }, data: { status: 'failed' } })
    return `Не поставил\n${escapeHtml(reason)}`
  }

  let work = null
  if (offer.workId) {
    work = await workFor(requester, offer.workId)
    if (!work) return fail('Такой работы у тебя нет или она уже не активна')
  }
  let task
  try {
    const created = await create({
      title: offer.title,
      description: offer.description,
      deadline: offer.deadline,
      startAt: offer.startAt,
      workId: offer.workId,
      ownerIds: [offer.assigneeId],
      user: requester,
    })
    task = created[0]
  } catch (e) {
    if (!e?.status) console.error(`[агент] задача по просьбе: ${e?.name}`)
    return fail(reasonOf(e))
  }
  await prisma.botTaskOffer.updateMany({ where: { id: offer.id }, data: { status: 'created', taskId: task.id } }).catch((e) => console.error(`[агент] связь карточки с задачей: ${e.name}`))

  const assignee = await prisma.user.findUnique({ where: { id: offer.assigneeId }, ...WHO })
  const label = escapeHtml(assignee ? labelOf(assignee) : 'Исполнитель')
  if (!(await chatOf(offer.assigneeId))) return `Поставил\n${label}\nТелеграм не подключён, задача в CRM`

  const sameDay = mskDayKey(offer.deadline) === mskDayKey(now)
  const text = assigneeText({ requester, title: offer.title, deadline: offer.deadline, work, note: offer.note ? cleanNote(offer.note) : null, now })
  const buttons = sameDay && !offer.workId ? [[{ text: 'Беру в работу', data: `tk:go:${task.id}` }]] : undefined
  const sent = await tell(offer.assigneeId, text, { buttons })
  return sent.ok ? `Поставил\n${label}` : `Поставил\n${label}\nСообщение не дошло, задача в CRM`
}

/** Честный ответ на нажатие по уже решённой карточке. */
function statusText(offer, now) {
  switch (offer?.status) {
    case 'created': return 'Уже поставлено'
    case 'cancelled': return 'Уже отменено'
    case 'failed': return 'Не получилось, попроси ещё раз'
    case 'creating': return now - offer.decidedAt > CREATING_STUCK_MS ? 'Не уверен, что задача поставилась, проверь в CRM' : 'Задача ещё ставится, подожди'
    default: return 'Уже обработано'
  }
}
