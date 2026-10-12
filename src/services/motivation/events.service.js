import { prisma } from '../../config/prisma.js'
import { ApiError } from '../../utils/ApiError.js'
import { assertCanManage, assertManager, loadEmployee, loadManagedEmployees } from './access.js'
import { assignmentAt, assignmentsAt } from './profiles.js'
import { eventEntry, eventTypeCard, profileCard } from './shape.js'

/**
 * Ручные баллы: события, которые фиксирует руководитель, корректировка на
 * произвольное число баллов и «клиент купил новый продукт». Плюс отмена
 * любого события, в том числе автоматического.
 *
 * Комментарий у всего ручного обязателен — так в задании: «добавлять и
 * отменять баллы вручную (с обязательным комментарием)». Через месяц никто
 * не вспомнит, за что человеку сняли три балла, если это не записано.
 */

const PRODUCT_KEY = 'client_product'

const EVENT_INCLUDE = {
  createdBy: { select: { id: true, name: true, email: true } },
  cancelledBy: { select: { id: true, name: true, email: true } },
}

// Баллы на одно событие. Шкала — сто баллов на месяц, поэтому больше ста
// за раз не бывает даже в корректировке.
function assertPoints(value, label) {
  if (!Number.isInteger(value) || value < -100 || value > 100) {
    throw ApiError.badRequest(`${label}: целое число от −100 до 100`)
  }
}

/**
 * Что можно поставить сотруднику вручную: события его профиля, которые
 * фиксирует руководитель. Автоматические сюда не попадают — их ставит
 * система по задачам, и ручная копия означала бы баллы дважды. «Клиент
 * купил продукт» тоже не попадает: у него своя кнопка и своя форма.
 */
export async function manualOptions(actor, userId) {
  assertManager(actor)
  const employee = await loadEmployee(userId)
  assertCanManage(actor, employee)

  const assignment = await assignmentAt(employee.id)
  const types = assignment?.profile?.eventTypes ?? []
  return {
    profile: profileCard(assignment?.profile),
    events: types
      .filter((t) => t.enabled && t.mode === 'manual' && t.systemKey !== PRODUCT_KEY)
      .map(eventTypeCard),
    product: (() => {
      const p = types.find((t) => t.systemKey === PRODUCT_KEY && t.enabled)
      return p ? eventTypeCard(p) : null
    })(),
  }
}

/**
 * Ручное событие или корректировка одному сотруднику.
 *
 * Событие берётся из текущего профиля человека, и баллы копируются в
 * запись: если админ потом поменяет цену события, уже начисленное не
 * пересчитается. Корректировка — любое число со знаком; по умолчанию одно и
 * то же в обе шкалы, но можно развести, как и у событий профиля.
 */
export async function addManual(actor, { userId, eventTypeId, prizePoints, levelPoints, comment }) {
  assertManager(actor)
  if (!comment?.trim()) throw ApiError.badRequest('Напишите комментарий: за что баллы')

  const employee = await loadEmployee(userId)
  assertCanManage(actor, employee)
  if (!employee.active) throw ApiError.badRequest('Сотрудник отключён')

  const assignment = await assignmentAt(employee.id)
  const profile = assignment?.profile ?? null

  let data
  if (eventTypeId) {
    const type = profile?.eventTypes.find((t) => t.id === eventTypeId)
    if (!type) throw ApiError.badRequest('Такого события нет в профиле сотрудника')
    if (!type.enabled) throw ApiError.badRequest('Это событие выключено в профиле')
    if (type.mode !== 'manual') throw ApiError.badRequest('Это событие начисляется автоматически по задачам')
    if (type.systemKey === PRODUCT_KEY) throw ApiError.badRequest('Покупку продукта отмечают кнопкой «Клиент купил новый продукт»')
    data = {
      kind: 'event',
      eventTypeId: type.id,
      title: type.title,
      prizePoints: type.prizePoints,
      levelPoints: type.levelPoints,
    }
  } else {
    const prize = Number(prizePoints)
    const level = levelPoints === undefined || levelPoints === null || levelPoints === '' ? prize : Number(levelPoints)
    assertPoints(prize, 'Баллы в премию')
    assertPoints(level, 'Баллы в уровень')
    if (prize === 0 && level === 0) throw ApiError.badRequest('Корректировка на ноль баллов ничего не меняет')
    data = { kind: 'adjustment', title: 'Ручная корректировка', prizePoints: prize, levelPoints: level }
  }

  const event = await prisma.motivationEvent.create({
    data: {
      ...data,
      userId: employee.id,
      profileId: profile?.id ?? null,
      mode: 'manual',
      comment: comment.trim(),
      occurredAt: new Date(),
      createdById: actor.id,
    },
    include: EVENT_INCLUDE,
  })
  return eventEntry(event)
}

/**
 * Клиент купил дополнительный продукт. Руководитель выбирает специалистов,
 * чья работа к этому привела, и каждый получает полные баллы события из
 * своего профиля — по заданию это +10, но цену админ может поменять.
 *
 * Если у кого-то в профиле это событие выключено или профиля нет вовсе,
 * операция отменяется целиком и говорит, у кого именно: иначе одни
 * получили бы баллы, а другие молча нет.
 */
export async function addProduct(actor, { userIds, clientId, product, comment }) {
  assertManager(actor)
  const users = await loadManagedEmployees(actor, userIds)
  const title = product?.trim()
  if (!title) throw ApiError.badRequest('Укажите, какой продукт купил клиент')

  const client = clientId
    ? await prisma.client.findUnique({ where: { id: clientId }, select: { id: true, name: true } })
    : null
  if (clientId && !client) throw ApiError.badRequest('Клиент не найден')

  const assignments = await assignmentsAt(users.map((u) => u.id))
  const plan = users.map((u) => {
    const profile = assignments.get(u.id)?.profile
    const type = profile?.eventTypes.find((t) => t.systemKey === PRODUCT_KEY && t.enabled)
    if (!type) {
      throw ApiError.badRequest(`${u.name || u.email}: в профиле нет включённого события «Клиент купил продукт»`)
    }
    return { user: u, profile, type }
  })

  const now = new Date()
  const created = await prisma.$transaction(
    plan.map(({ user, profile, type }) =>
      prisma.motivationEvent.create({
        data: {
          userId: user.id,
          profileId: profile.id,
          eventTypeId: type.id,
          kind: 'product',
          mode: 'manual',
          title: `${type.title}: ${title}`,
          prizePoints: type.prizePoints,
          levelPoints: type.levelPoints,
          clientId: client?.id ?? null,
          clientName: client?.name ?? null,
          comment: comment?.trim() || null,
          occurredAt: now,
          createdById: actor.id,
        },
        include: EVENT_INCLUDE,
      }),
    ),
  )
  return { events: created.map((e) => eventEntry(e)), count: created.length }
}

/**
 * Отмена события. Удалять события нельзя — только отменить с причиной.
 * Отменённое остаётся в истории зачёркнутым, а баллы пересчитываются сами:
 * расчёт отменённые записи просто пропускает.
 */
export async function cancelEvent(actor, id, { reason }) {
  assertManager(actor)
  if (!reason?.trim()) throw ApiError.badRequest('Напишите, почему отменяете событие')

  const event = await prisma.motivationEvent.findUnique({ where: { id } })
  if (!event) throw ApiError.notFound('Событие не найдено')

  const employee = await loadEmployee(event.userId)
  assertCanManage(actor, employee)
  if (event.cancelledAt) throw ApiError.conflict('Событие уже отменено')

  // updateMany с условием «ещё не отменено» — защита от двойного клика:
  // вторая отмена ничего не перезапишет, даже если пришла одновременно.
  const res = await prisma.motivationEvent.updateMany({
    where: { id, cancelledAt: null },
    data: { cancelledAt: new Date(), cancelledById: actor.id, cancelReason: reason.trim() },
  })
  if (res.count === 0) throw ApiError.conflict('Событие уже отменено')

  const updated = await prisma.motivationEvent.findUnique({ where: { id }, include: EVENT_INCLUDE })
  return eventEntry(updated)
}
