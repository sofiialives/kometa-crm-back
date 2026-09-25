import { prisma } from '../config/prisma.js'
import { ApiError } from '../utils/ApiError.js'

/**
 * Доска клиентов — финансовый учёт агентства.
 *
 * Видит и меняет только админ. Это выручка, расходы и прибыль всего
 * агентства: заказчик на вопрос «кто видит» ответил односложно — «только я».
 */

function assertAdmin(user) {
  if (user.role !== 'admin') throw ApiError.forbidden('Доска клиентов доступна только админу')
}

const DAY_MS = 24 * 60 * 60 * 1000

// Деньги приходят с фронта в долларах, в базе лежат в центах. Округляем
// здесь один раз: дальше по всему коду только целые числа, и сложение
// никогда не даёт 0.30000000000000004.
const toCents = (dollars) => Math.round(Number(dollars) * 100)

const expenseRows = (expenses) =>
  (expenses || []).map((e) => ({ title: e.title.trim(), amountCents: toCents(e.amount) }))

/** Первое число месяца по UTC — к нему привязана каждая услуга. */
function monthStart(value) {
  const d = new Date(value)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
}

/**
 * Границы выбранного периода.
 *
 * Возвращает null для режима «за всё время» — тогда фильтра по месяцу нет
 * вовсе.
 *
 * В режиме произвольного периода услуга попадает в выборку, если первое
 * число её месяца лежит в заданном диапазоне. Границы при этом НЕ округляем
 * до месяца: округление наружу превратило бы «последние 90 дней» в четыре
 * месяца вместо трёх, и сводка показала бы больше, чем есть.
 *
 * Следствие: данные помесячные, половинок месяца не бывает. «С 15 сентября»
 * сентябрь уже не захватит — его первое число осталось позади.
 */
export function resolveRange({ mode, month, from, to }) {
  if (mode === 'all') return null

  if (mode === 'month') {
    const start = monthStart(month)
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1))
    return { gte: start, lt: end }
  }

  const range = {}
  if (from) range.gte = new Date(from)
  if (to) range.lte = new Date(to)
  return Object.keys(range).length ? range : null
}

const SERVICE_SELECT = {
  id: true,
  title: true,
  month: true,
  revenueCents: true,
  expenses: { select: { id: true, title: true, amountCents: true }, orderBy: { createdAt: 'asc' } },
}

/** Выручка, расход и прибыль по набору услуг. Единственное место, где это считается. */
function totals(services) {
  let revenueCents = 0
  let expenseCents = 0
  for (const s of services) {
    revenueCents += s.revenueCents
    for (const e of s.expenses) expenseCents += e.amountCents
  }
  return { revenueCents, expenseCents, profitCents: revenueCents - expenseCents }
}

/** Сколько дней клиент с нами. У ушедшего счёт останавливается датой ухода. */
function daysWithUs(card) {
  const end = card.leftAt ? new Date(card.leftAt) : new Date()
  return Math.max(0, Math.floor((end - new Date(card.startedAt)) / DAY_MS))
}

// ---------------------------------------------------------------------------
// Доска
// ---------------------------------------------------------------------------

/**
 * Вся доска: сводка сверху и две колонки карточек.
 *
 * Колонка — это текущее состояние клиента, а не вычисление по выбранному
 * месяцу. Так решил заказчик: клиент без платежа в месяце «уже будет во
 * вкладке ушёл висеть». Поэтому, открыв июль, ушедшего в августе увидишь
 * среди ушедших.
 *
 * Цифры на карточке — за выбранный период. Иначе переключение месяцев
 * ничего бы не меняло, а вся доска ради этого и делается. Исключение —
 * «дней с нами» и «услуг за всё время»: они по смыслу общие.
 */
export async function getBoard(user, query) {
  assertAdmin(user)
  const range = resolveRange(query)

  const cards = await prisma.boardClient.findMany({
    include: {
      client: { select: { id: true, name: true } },
      services: { where: range ? { month: range } : undefined, select: SERVICE_SELECT },
      _count: { select: { services: true } },
    },
    orderBy: { client: { name: 'asc' } },
  })

  const shaped = cards.map((c) => ({
    id: c.id,
    client: c.client,
    contact: c.contact,
    status: c.status,
    startedAt: c.startedAt,
    leftAt: c.leftAt,
    leftReason: c.leftReason,
    daysWithUs: daysWithUs(c),
    // Количество услуг за всё время — так и написано в задании, «не
    // зависящее от периода».
    serviceCountTotal: c._count.services,
    serviceCountInPeriod: c.services.length,
    ...totals(c.services),
  }))

  const active = shaped.filter((c) => c.status === 'active')
  const left = shaped.filter((c) => c.status === 'left')

  return {
    // Сводка считается по обеим колонкам сразу: выручка ушедшего клиента за
    // тот месяц, когда он ещё работал, — это выручка агентства за тот месяц.
    summary: {
      ...totals(cards.flatMap((c) => c.services)),
      activeCount: active.length,
      leftCount: left.length,
    },
    active,
    left,
  }
}

/** Карточка целиком: услуги выбранного периода с расходами по каждой. */
export async function getCard(user, id, query) {
  assertAdmin(user)
  const range = resolveRange(query)

  const card = await prisma.boardClient.findUnique({
    where: { id },
    include: {
      client: { select: { id: true, name: true } },
      addedBy: { select: { id: true, name: true } },
      services: {
        where: range ? { month: range } : undefined,
        select: SERVICE_SELECT,
        orderBy: [{ month: 'desc' }, { title: 'asc' }],
      },
      _count: { select: { services: true } },
    },
  })
  if (!card) throw ApiError.notFound('Клиент на доске не найден')

  const services = card.services.map((s) => ({
    ...s,
    // Прибыль по услуге считает сервер, а не форма: одно место, где живёт
    // эта арифметика, и в отчётах она не разойдётся с тем, что видно в
    // карточке.
    ...totals([s]),
  }))

  return {
    ...card,
    services,
    daysWithUs: daysWithUs(card),
    serviceCountTotal: card._count.services,
    ...totals(card.services),
  }
}

// ---------------------------------------------------------------------------
// Клиенты
// ---------------------------------------------------------------------------

export async function addClient(user, { clientId, clientName, contact, startedAt, services }) {
  assertAdmin(user)

  let id = clientId
  if (!id) {
    // Клиента можно завести прямо здесь, не уходя в справочник. Список при
    // этом остаётся один на всю CRM — отдельной базы клиентов у доски нет.
    const name = String(clientName || '').trim()
    if (!name) throw ApiError.badRequest('Выберите клиента или укажите название')
    const existing = await prisma.client.findUnique({ where: { name } })
    id = existing ? existing.id : (await prisma.client.create({ data: { name } })).id
  } else if (!(await prisma.client.findUnique({ where: { id } }))) {
    throw ApiError.notFound('Клиент не найден')
  }

  try {
    return await prisma.boardClient.create({
      data: {
        clientId: id,
        contact: contact || null,
        startedAt: startedAt || new Date(),
        addedById: user.id,
        // Услуги можно завести сразу в форме — так и описано в задании:
        // «нажали на кнопочку новый клиент, у нас прямо большой лист,
        // который нужно заполнить». Заводить клиента, а потом отдельно
        // ходить за услугами — лишний шаг там, где его не просили.
        ...(services?.length
          ? {
            services: {
              create: services.map((s) => ({
                title: s.title.trim(),
                month: monthStart(s.month),
                revenueCents: toCents(s.revenue),
                expenses: { create: expenseRows(s.expenses) },
              })),
            },
          }
          : {}),
      },
      include: { client: { select: { id: true, name: true } } },
    })
  } catch (e) {
    if (e.code === 'P2002') throw ApiError.conflict('Этот клиент уже на доске')
    throw e
  }
}

export async function editClient(user, id, patch) {
  assertAdmin(user)
  try {
    return await prisma.boardClient.update({
      where: { id },
      data: {
        ...(patch.contact !== undefined ? { contact: patch.contact || null } : {}),
        ...(patch.startedAt !== undefined ? { startedAt: patch.startedAt } : {}),
      },
      include: { client: { select: { id: true, name: true } } },
    })
  } catch (e) {
    if (e.code === 'P2025') throw ApiError.notFound('Клиент на доске не найден')
    throw e
  }
}

/** Клиент ушёл. Причина обязательна — ради неё колонка ушедших и нужна. */
export async function markLeft(user, id, { reason, leftAt }) {
  assertAdmin(user)
  const card = await prisma.boardClient.findUnique({ where: { id } })
  if (!card) throw ApiError.notFound('Клиент на доске не найден')

  const at = leftAt ? new Date(leftAt) : new Date()
  if (at < new Date(card.startedAt)) {
    throw ApiError.badRequest('Дата ухода раньше начала работы с клиентом')
  }

  return prisma.boardClient.update({
    where: { id },
    data: { status: 'left', leftAt: at, leftReason: reason },
    include: { client: { select: { id: true, name: true } } },
  })
}

/** Вернуть в работу. Причина и дата ухода стираются — клиент снова с нами. */
export async function markActive(user, id) {
  assertAdmin(user)
  try {
    return await prisma.boardClient.update({
      where: { id },
      data: { status: 'active', leftAt: null, leftReason: null },
      include: { client: { select: { id: true, name: true } } },
    })
  } catch (e) {
    if (e.code === 'P2025') throw ApiError.notFound('Клиент на доске не найден')
    throw e
  }
}

export async function removeClient(user, id) {
  assertAdmin(user)
  try {
    await prisma.boardClient.delete({ where: { id } })
  } catch (e) {
    if (e.code === 'P2025') throw ApiError.notFound('Клиент на доске не найден')
    throw e
  }
}

// ---------------------------------------------------------------------------
// Услуги
// ---------------------------------------------------------------------------

/**
 * Услуга за месяц. Расходы приходят и сохраняются вместе с ней: в форме это
 * один блок, и отдельные ручки на каждую строку расхода только добавили бы
 * запросов там, где хватает одного.
 */
export async function addService(user, { boardClientId, title, month, revenue, expenses }) {
  assertAdmin(user)
  if (!(await prisma.boardClient.findUnique({ where: { id: boardClientId } }))) {
    throw ApiError.notFound('Клиент на доске не найден')
  }

  return prisma.boardService.create({
    data: {
      boardClientId,
      title: title.trim(),
      month: monthStart(month),
      revenueCents: toCents(revenue),
      expenses: { create: expenseRows(expenses) },
    },
    select: SERVICE_SELECT,
  })
}

export async function editService(user, id, { title, month, revenue, expenses }) {
  assertAdmin(user)
  const service = await prisma.boardService.findUnique({ where: { id } })
  if (!service) throw ApiError.notFound('Услуга не найдена')

  // Расходы заменяем целиком, а не правим по одному: форма присылает весь
  // список, и так убранная строка действительно исчезает.
  return prisma.$transaction(async (tx) => {
    if (expenses !== undefined) {
      await tx.boardExpense.deleteMany({ where: { serviceId: id } })
    }
    return tx.boardService.update({
      where: { id },
      data: {
        ...(title !== undefined ? { title: title.trim() } : {}),
        ...(month !== undefined ? { month: monthStart(month) } : {}),
        ...(revenue !== undefined ? { revenueCents: toCents(revenue) } : {}),
        ...(expenses !== undefined ? { expenses: { create: expenseRows(expenses) } } : {}),
      },
      select: SERVICE_SELECT,
    })
  })
}

export async function removeService(user, id) {
  assertAdmin(user)
  try {
    await prisma.boardService.delete({ where: { id } })
  } catch (e) {
    if (e.code === 'P2025') throw ApiError.notFound('Услуга не найдена')
    throw e
  }
}

/**
 * Месяцы, по которым вообще есть данные, — для выпадающего списка.
 * Предлагать пустые месяцы незачем.
 */
export async function listMonths(user) {
  assertAdmin(user)
  const rows = await prisma.boardService.findMany({
    select: { month: true },
    distinct: ['month'],
    orderBy: { month: 'desc' },
  })
  return rows.map((r) => r.month)
}
