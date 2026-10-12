import { prisma } from '../../config/prisma.js'
import { ApiError } from '../../utils/ApiError.js'
import { assertAdmin, assertCanManage, assertManager, loadEmployee, loadManagedEmployees } from './access.js'
import { currentMonthKey } from './month.js'
import { loadMonthState } from './overview.service.js'
import { bankEntry } from './shape.js'

/**
 * Пополнение и списание банка.
 *
 * Пополняют руководитель (свой отдел) и админ (всех). Уменьшить банк может
 * только админ, отдельной операцией «Списание из банка» с обязательным
 * комментарием — например, когда пополнили по ошибке. Записи журнала не
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
export async function topUp(actor, { userIds, amount, reason, clientId, comment }) {
  assertManager(actor)
  const cents = toCents(amount)
  if (!(cents > 0)) throw ApiError.badRequest('Сумма пополнения должна быть больше нуля')
  if (reason === 'new_client' && !clientId) throw ApiError.badRequest('Выберите клиента, за которого пополняется банк')

  const users = await loadManagedEmployees(actor, userIds)
  const client = await resolveClient(clientId)
  const now = new Date()

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
          createdById: actor.id,
        },
        include: { createdBy: { select: { id: true, name: true, email: true } } },
      }),
    ),
  )
  return { entries: created.map((e) => bankEntry(e)), count: created.length }
}

/**
 * Списание из банка. Только админ, только с комментарием, и не больше, чем
 * сейчас лежит в банке текущего месяца: в минус банк не уходит.
 */
export async function writeOff(actor, { userId, amount, comment }) {
  assertAdmin(actor)
  const cents = toCents(amount)
  if (!(cents > 0)) throw ApiError.badRequest('Сумма списания должна быть больше нуля')
  if (!comment?.trim()) throw ApiError.badRequest('Напишите, почему списываете: это останется в истории банка')

  const employee = await loadEmployee(userId)
  assertCanManage(actor, employee)

  const { result } = await loadMonthState(employee.id, currentMonthKey())
  if (cents > result.bankCents) {
    throw ApiError.badRequest(`В банке сейчас ${(result.bankCents / 100).toLocaleString('ru-RU')} $ — больше списать нельзя`)
  }

  const entry = await prisma.motivationBankEntry.create({
    data: {
      userId: employee.id,
      kind: 'write_off',
      amountCents: -cents,
      comment: comment.trim(),
      occurredAt: new Date(),
      createdById: actor.id,
    },
    include: { createdBy: { select: { id: true, name: true, email: true } } },
  })
  return bankEntry(entry)
}
