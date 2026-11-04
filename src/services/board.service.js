import { prisma } from '../config/prisma.js'
import { ApiError } from '../utils/ApiError.js'
import {
  buildBoard, daysWithUs, dayStart, expenseRows, fillWorkSpan, monthsOfService, monthStart, moscowToday, resolveRange,
  resolvePaidAt, servicePrefilter, serviceVisible, shapeService, toCents, totals, workSpanProblem,
} from './boardRules.js'

/**
 * Доска клиентов — финансовый учёт агентства.
 *
 * Видит и меняет только админ. Это выручка, расходы и прибыль всего
 * агентства: заказчик на вопрос «кто видит» ответил односложно — «только я».
 */

function assertAdmin(user) {
  if (user.role !== 'admin') throw ApiError.forbidden('Доска клиентов доступна только админу')
}

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

const EXPENSE_SELECT = { id: true, title: true, amountCents: true, paid: true, paidAt: true }

const SERVICE_SELECT = {
  id: true,
  title: true,
  month: true,
  paidAt: true,
  workFrom: true,
  workTo: true,
  revenueCents: true,
  expenses: { select: EXPENSE_SELECT, orderBy: { createdAt: 'asc' } },
}

// ---------------------------------------------------------------------------
// Доска
// ---------------------------------------------------------------------------

/**
 * Вся доска: сводка сверху и две колонки карточек.
 *
 * Всё считается по выбранному периоду. Услуга в нём видна, если её месяц в
 * периоде или в эти дни шла работа по ней (доделки). Карточка клиента есть
 * в периоде, если есть видимая услуга или он в нём ушёл; клиент вообще без
 * услуг виден по своим датам, а клиент, пришедший в ноябре, в октябре не
 * висит (см. cardVisible).
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

  // Карточки берём все: нужно знать, кто на доске (сводка отдаёт их id), и
  // видимость клиента без услуг зависит от его дат. Услуги — только те,
  // что могут быть видны в периоде; окончательно решает serviceVisible, а
  // сколько их всего, считает база.
  const cards = await prisma.boardClient.findMany({
    include: {
      client: { select: { id: true, name: true } },
      services: { where: servicePrefilter(range), select: SERVICE_SELECT },
      _count: { select: { services: true } },
    },
    orderBy: { client: { name: 'asc' } },
  })

  return buildBoard(cards, range)
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

  // Сроки работ проверяем до того, как заводить клиента в справочнике:
  // иначе при ошибке в услуге он остался бы там без карточки на доске.
  const spans = (services || []).map((s) => workSpanData(s.month, s.workFrom, s.workTo))

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
        // По Москве: в первые три часа месяца UTC ещё живёт прошлым.
        startedAt: startedAt || moscowToday(),
        addedById: user.id,
        // Услуги можно завести сразу в форме — так и описано в задании:
        // «нажали на кнопочку новый клиент, у нас прямо большой лист,
        // который нужно заполнить». Заводить клиента, а потом отдельно
        // ходить за услугами — лишний шаг там, где его не просили.
        ...(services?.length
          ? {
            services: {
              create: services.map((s, i) => ({
                title: s.title.trim(),
                month: monthStart(s.month),
                paidAt: s.paidAt || null,
                ...spans[i],
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

  const at = leftAt ? new Date(leftAt) : moscowToday()
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
  // список, и так убранная строка действительно исчезает. Отметка
  // «выплачено» при этом переживает замену (см. expenseRows): прежние
  // расходы читаем до удаления.
  const updated = await prisma.$transaction(async (tx) => {
    let rows
    if (expenses !== undefined) {
      rows = expenseRows(expenses, await tx.boardExpense.findMany({ where: { serviceId: id } }))
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
        ...(expenses !== undefined ? { expenses: { create: rows } } : {}),
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
 * Галочка «выплачено» у одного расхода. Отдельная ручка, а не правка услуги:
 * ставят её щелчком прямо в списке, и пересылать ради этого всю форму
 * незачем. Дату выплаты выбирает владелец (paidAt); не выбрал — сегодня по
 * Москве. Считается так же, как при правке услуги (см. resolvePaidAt): сняли —
 * стёрлась, повторный запрос без даты прежнюю не двигает.
 */
export async function setExpensePaid(user, id, { paid, paidAt }) {
  assertAdmin(user)
  const expense = await prisma.boardExpense.findUnique({ where: { id } })
  if (!expense) throw ApiError.notFound('Расход не найден')

  try {
    return await prisma.boardExpense.update({
      where: { id },
      data: { paid, paidAt: resolvePaidAt(expense, paid, paidAt) },
      select: { ...EXPENSE_SELECT, serviceId: true },
    })
  } catch (e) {
    // Расход могли убрать правкой услуги между чтением и записью.
    if (e.code === 'P2025') throw ApiError.notFound('Расход не найден')
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
  // Одинаковых сочетаний месяца и срока много (у каждого клиента услуги
  // одного месяца), поэтому группируем в базе, а не читаем строку на услугу.
  const rows = await prisma.boardService.groupBy({ by: ['month', 'workFrom', 'workTo'] })
  const months = new Map()
  for (const row of rows) {
    for (const m of monthsOfService(row)) months.set(m.getTime(), m)
  }
  return [...months.values()].sort((a, b) => b.getTime() - a.getTime())
}
