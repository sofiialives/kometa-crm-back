import { prisma } from '../../config/prisma.js'
import { ApiError } from '../../utils/ApiError.js'
import { assertAdmin, assertCanManage, loadEmployee, loadManagedEmployees } from './access.js'
import { currentMonthKey, monthRange } from './month.js'
import { loadMonthState } from './overview.service.js'
import { bankEntry } from './shape.js'
import { requestKeyFor, isDuplicate } from './dedupe.js'

/**
 * Пополнение и списание банка.
 *
 * И то и другое делает только владелец: он пополняет банк и сотрудникам, и
 * руководителям. Уменьшить банк можно отдельной операцией «Списание из
 * банка» с обязательным комментарием — например, когда пополнили по ошибке. Записи журнала не
 * удаляются и не правятся: ошибка исправляется новой записью, и в истории
 * видно и ошибку, и исправление.
 */

// Деньги приходят в долларах, хранятся в центах — как на доске клиентов.
const toCents = (dollars) => Math.round(Number(dollars) * 100)

export const BANK_REASON_LABELS = {
  new_client: 'Новый клиент',
  free_budget: 'Свободный бюджет',
  other: 'Другое',
}

async function resolveClient(clientId) {
  if (!clientId) return null
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { id: true, name: true } })
  if (!client) throw ApiError.badRequest('Клиент не найден')
  return client
}

/**
 * Пополнить банк одному или нескольким сотрудникам разом. Каждому кладётся
 * полная сумма: «по 50 $ троим», а не «50 $ на троих». Так устроена форма
 * в задании — сотрудников выбирают нескольких, сумму вводят одну.
 */
export async function topUp(actor, { userIds, amount, reason, clientId, comment, requestKey }) {
  assertAdmin(actor, 'Пополнять банк может только владелец')
  const cents = toCents(amount)
  if (!(cents > 0)) throw ApiError.badRequest('Сумма пополнения должна быть больше нуля')
  if (reason === 'new_client' && !clientId) throw ApiError.badRequest('Выберите клиента, за которого пополняется банк')

  const users = await loadManagedEmployees(actor, userIds)
  const client = await resolveClient(clientId)
  const now = new Date()
  const include = { createdBy: { select: { id: true, name: true } } }

  try {
    const created = await prisma.$transaction(
      users.map((u) =>
        prisma.motivationBankEntry.create({
          data: {
            userId: u.id,
            kind: 'top_up',
            reason,
            amountCents: cents,
            clientId: client?.id ?? null,
            clientName: client?.name ?? null,
            comment: comment?.trim() || null,
            occurredAt: now,
            dedupeKey: requestKeyFor(requestKey, u.id),
            createdById: actor.id,
          },
          include,
        }),
      ),
    )
    return { entries: created.map((e) => bankEntry(e)), count: created.length, duplicate: false }
  } catch (e) {
    // Тот же запрос уже прошёл: двойное нажатие или повтор после обрыва
    // связи. Деньги второй раз не кладём, а отвечаем тем, что уже лежит, —
    // форма закроется так же, как после первого раза.
    if (!isDuplicate(e, requestKey)) throw e
    const existing = await prisma.motivationBankEntry.findMany({
      where: { dedupeKey: { in: users.map((u) => requestKeyFor(requestKey, u.id)) } },
      include,
    })
    return { entries: existing.map((x) => bankEntry(x)), count: existing.length, duplicate: true }
  }
}

/**
 * Списание из банка. Только админ, только с комментарием, и не больше, чем
 * сейчас лежит в банке текущего месяца: в минус банк не уходит.
 */
export async function writeOff(actor, { userId, amount, comment }) {
  assertAdmin(actor, 'Списывать из банка может только владелец')
  const cents = toCents(amount)
  if (!(cents > 0)) throw ApiError.badRequest('Сумма списания должна быть больше нуля')
  if (!comment?.trim()) throw ApiError.badRequest('Напишите, почему списываете: это останется в истории банка')

  const employee = await loadEmployee(userId)
  assertCanManage(actor, employee)

  const monthKey = currentMonthKey()
  // Стартовая сумма месяца должна уже лежать в журнале, иначе банк ниже
  // окажется меньше настоящего.
  await loadMonthState(employee, monthKey)
  const { start, end } = monthRange(monthKey)

  // Проверка «не больше банка» и запись — в одной транзакции под замком на
  // сотрудника. Без замка два одновременных списания оба прошли бы проверку
  // по одному и тому же банку, и журнал разошёлся бы с экраном.
  const entry = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${employee.id}))`
    const sum = await tx.motivationBankEntry.aggregate({
      where: { userId: employee.id, occurredAt: { gte: start, lt: end } },
      _sum: { amountCents: true },
    })
    const bankCents = Math.max(0, sum._sum.amountCents ?? 0)
    if (cents > bankCents) {
      throw ApiError.badRequest(`В банке сейчас ${(bankCents / 100).toLocaleString('ru-RU')} $ — больше списать нельзя`)
    }
    return tx.motivationBankEntry.create({
      data: {
        userId: employee.id,
        kind: 'write_off',
        amountCents: -cents,
        comment: comment.trim(),
        occurredAt: new Date(),
        createdById: actor.id,
      },
      include: { createdBy: { select: { id: true, name: true } } },
    })
  })
  return bankEntry(entry)
}
