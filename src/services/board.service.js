import { prisma } from '../config/prisma.js'
import { ApiError } from '../utils/ApiError.js'
import {
  cardVisible, columnOf, DAY_MS, dayStart, fillWorkSpan, monthsOfService, monthStart, resolveRange, serviceInPeriod,
  serviceVisible, shapeService, totals, workSpanProblem,
} from './boardRules.js'

export { resolveRange }

/**
 * Доска клиентов — финансовый учёт агентства.
 *
 * Видит и меняет только админ. Это выручка, расходы и прибыль всего
 * агентства: заказчик на вопрос «кто видит» ответил односложно — «только я».
 */

function assertAdmin(user) {
  if (user.role !== 'admin') throw ApiError.forbidden('Доска клиентов доступна только админу')
}

// Деньги приходят с фронта в долларах, в базе лежат в центах. Округляем
// здесь один раз: дальше по всему коду только целые числа, и сложение
// никогда не даёт 0.30000000000000004.
const toCents = (dollars) => Math.round(Number(dollars) * 100)

const expenseRows = (expenses) =>
  (expenses || []).map((e) => ({ title: e.title.trim(), amountCents: toCents(e.amount) }))

/**
 * Срок работ к записи в базу: дни целиком (полночь UTC), пусто — null.
 * Проверяется вместе с месяцем услуги (см. workSpanProblem). Обе границы
 * между собой проверяет ещё и схема, здесь это повторяется для случая, когда
 * одна из них пришла в запросе, а вторая лежит в базе.
 */
function workSpanData(month, workFrom, workTo) {
  const from = workFrom ? dayStart(workFrom) : null
  const to = workTo ? dayStart(workTo) : null
  const problem = workSpanProblem({ month, workFrom: from, workTo: to })
  if (problem) throw ApiError.badRequest(problem)
  return { workFrom: from, workTo: to }
}

const SERVICE_SELECT = {
  id: true,
  title: true,
  month: true,
  paidAt: true,
  workFrom: true,
  workTo: true,
  revenueCents: true,
  expenses: {
    select: { id: true, title: true, amountCents: true, paid: true, paidAt: true },
    orderBy: { createdAt: 'asc' },
  },
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
 * Всё считается по выбранному периоду. Услуга в нём видна, если её месяц в
 * периоде или в эти дни шла работа по ней (доделки). Карточка клиента есть
 * в периоде, если есть видимая услуга; клиент вообще без услуг виден по
 * своим датам, а клиент, пришедший в ноябре, в октябре не висит (см.
 * cardVisible).
 *
 * Колонка тоже зависит от периода: в «Ушедших» клиент, который ушёл в нём
 * или раньше, а если ушёл позже, то в том периоде он ещё «В работе» (см.
 * columnOf). Раньше колонка была текущим состоянием клиента, и ушедший в
 * августе числился ушедшим даже в июле.
 *
 * Деньги, напротив, остаются в своём месяце: в суммы входят только услуги,
 * месяц которых в периоде. Доделки в карточке показываются, но не считаются.
 * Исключение из «за период» — «дней с нами» и «услуг за всё время»: они по
 * смыслу общие.
 */
export async function getBoard(user, query) {
  assertAdmin(user)
  const range = resolveRange(query)

  // Услуги берём все, а не только за период: «видна ли» решают правила
  // (месяц или срок работ), и в условие запроса с пустыми краями срока
  // работ это не уложить. Доска одна на агентство, объёмы небольшие.
  const cards = await prisma.boardClient.findMany({
    include: {
      client: { select: { id: true, name: true } },
      services: { select: SERVICE_SELECT },
    },
    orderBy: { client: { name: 'asc' } },
  })

  const active = []
  const left = []
  const visibleServices = []

  for (const c of cards) {
    const visible = c.services.filter((s) => serviceVisible(s, range))
    if (!cardVisible({
      startedAt: c.startedAt, leftAt: c.leftAt, serviceCount: c.services.length, visibleCount: visible.length,
    }, range)) continue

    visibleServices.push(...visible)
    const card = {
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
      serviceCountTotal: c.services.length,
      // Сколько услуг дают деньги в периоде, а сколько видно всего: разница
      // — доделки, их деньги лежат в другом месяце.
      serviceCountInPeriod: visible.filter((s) => serviceInPeriod(s, range)).length,
      serviceCountVisible: visible.length,
      ...totals(visible, range),
    }
    const column = columnOf(c, range) === 'left' ? left : active
    column.push(card)
  }

  return {
    // Сводка считается по обеим колонкам сразу: выручка ушедшего клиента за
    // тот месяц, когда он ещё работал, — это выручка агентства за тот месяц.
    summary: {
      ...totals(visibleServices, range),
      activeCount: active.length,
      leftCount: left.length,
    },
    active,
    left,
  }
}

/**
 * Карточка целиком: услуги, видимые в выбранном периоде, с расходами по
 * каждой. Итоги — только по услугам, чей месяц в периоде; у остальных
 * (доделок) inPeriod = false.
 */
export async function getCard(user, id, query) {
  assertAdmin(user)
  const range = resolveRange(query)

  const card = await prisma.boardClient.findUnique({
    where: { id },
    include: {
      client: { select: { id: true, name: true } },
      addedBy: { select: { id: true, name: true } },
      services: {
        select: SERVICE_SELECT,
        orderBy: [{ month: 'desc' }, { title: 'asc' }],
      },
      _count: { select: { services: true } },
    },
  })
  if (!card) throw ApiError.notFound('Клиент на доске не найден')

  const visible = card.services.filter((s) => serviceVisible(s, range))

  // Прибыль по услуге считает сервер, а не форма: одно место, где живёт
  // эта арифметика, и в отчётах она не разойдётся с тем, что видно в
  // карточке.
  const services = visible.map((s) => shapeService(s, range))

  return {
    ...card,
    services,
    daysWithUs: daysWithUs(card),
    serviceCountTotal: card._count.services,
    ...totals(visible, range),
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
    // Ищем без оглядки на регистр: «ozon» рядом с «Ozon» — это не новый
    // клиент, а тот же самый, набранный иначе.
    const existing = await prisma.client.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } },
    })
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
                paidAt: s.paidAt || null,
                ...workSpanData(s.month, s.workFrom, s.workTo),
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
export async function addService(user, { boardClientId, title, month, paidAt, workFrom, workTo, revenue, expenses }) {
  assertAdmin(user)
  if (!(await prisma.boardClient.findUnique({ where: { id: boardClientId } }))) {
    throw ApiError.notFound('Клиент на доске не найден')
  }

  const created = await prisma.boardService.create({
    data: {
      boardClientId,
      title: title.trim(),
      month: monthStart(month),
      paidAt: paidAt || null,
      ...workSpanData(month, workFrom, workTo),
      revenueCents: toCents(revenue),
      expenses: { create: expenseRows(expenses) },
    },
    select: SERVICE_SELECT,
  })
  return fillWorkSpan(created)
}

export async function editService(user, id, { title, month, paidAt, workFrom, workTo, revenue, expenses }) {
  assertAdmin(user)
  const service = await prisma.boardService.findUnique({ where: { id } })
  if (!service) throw ApiError.notFound('Услуга не найдена')

  // Срок проверяем вместе с тем, что уже лежит в базе: прийти может одна
  // граница или только новый месяц. Если ни то, ни другое не правят, срок не
  // трогаем вовсе — иначе правка названия упиралась бы в старые данные.
  const work = month !== undefined || workFrom !== undefined || workTo !== undefined
    ? workSpanData(
      month !== undefined ? month : service.month,
      workFrom !== undefined ? workFrom : service.workFrom,
      workTo !== undefined ? workTo : service.workTo,
    )
    : null

  // Расходы заменяем целиком, а не правим по одному: форма присылает весь
  // список, и так убранная строка действительно исчезает.
  const updated = await prisma.$transaction(async (tx) => {
    if (expenses !== undefined) {
      await tx.boardExpense.deleteMany({ where: { serviceId: id } })
    }
    return tx.boardService.update({
      where: { id },
      data: {
        ...(title !== undefined ? { title: title.trim() } : {}),
        ...(month !== undefined ? { month: monthStart(month) } : {}),
        ...(paidAt !== undefined ? { paidAt } : {}),
        ...(workFrom !== undefined ? { workFrom: work.workFrom } : {}),
        ...(workTo !== undefined ? { workTo: work.workTo } : {}),
        ...(revenue !== undefined ? { revenueCents: toCents(revenue) } : {}),
        ...(expenses !== undefined ? { expenses: { create: expenseRows(expenses) } } : {}),
      },
      select: SERVICE_SELECT,
    })
  })
  return fillWorkSpan(updated)
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
 * Предлагать пустые месяцы незачем. Месяц, в который тянется срок работ,
 * не пустой: в нём видны доделки.
 */
export async function listMonths(user) {
  assertAdmin(user)
  const rows = await prisma.boardService.findMany({ select: { month: true, workFrom: true, workTo: true } })
  const months = new Map()
  for (const row of rows) {
    for (const m of monthsOfService(row)) months.set(m.getTime(), m)
  }
  return [...months.values()].sort((a, b) => b.getTime() - a.getTime())
}
