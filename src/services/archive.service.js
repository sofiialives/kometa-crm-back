import { randomUUID } from 'node:crypto'
import { extractText, getDocumentProxy } from 'unpdf'
import { prisma } from '../config/prisma.js'
import { ApiError } from '../utils/ApiError.js'
import { deleteObject, getObjectStream, putObject } from '../utils/storage.js'

const PERSON = { id: true, name: true, avatarUrl: true, avatarColor: true }

/** «1 отчёт», «3 отчёта», «5 отчётов» — иначе сообщения выглядят неряшливо. */
function reportsWord(n) {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return `${n} отчёт`
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} отчёта`
  return `${n} отчётов`
}

// Текста из PDF хватает и столько: это не содержимое для показа, а только
// сырьё для поиска. Потолок защищает базу от отчёта на тысячу страниц.
const MAX_TEXT_CHARS = 200_000

// ---------------------------------------------------------------------------
// Видимость
//
// Заказчик решил: отчёты видят сотрудники соответствующего отдела. Значит
// staff и lead работают только со своим отделом, админ — со всеми. Отдел
// живёт на услуге, поэтому вся проверка сводится к нему.
// ---------------------------------------------------------------------------

function assertDepartmentVisible(user, departmentId) {
  if (user.role === 'admin') return
  if (!user.departmentId) {
    throw ApiError.forbidden('Вы не привязаны к отделу, поэтому архив недоступен')
  }
  if (user.departmentId !== departmentId) {
    throw ApiError.forbidden('Архив другого отдела недоступен')
  }
}

/**
 * Какой отдел показывать. Админ может попросить конкретный или получить
 * все сразу; остальным отдел подставляется свой, а чужой — отказ.
 * Возвращает null, если ограничения нет (админ без выбранной вкладки).
 */
function resolveDepartment(user, requested) {
  if (user.role === 'admin') return requested || null
  if (!user.departmentId) throw ApiError.forbidden('Вы не привязаны к отделу, поэтому архив недоступен')
  if (requested && requested !== user.departmentId) throw ApiError.forbidden('Архив другого отдела недоступен')
  return user.departmentId
}

/** Заводить услуги может админ везде, руководитель — у себя. */
function assertCanManageServices(user, departmentId) {
  if (user.role === 'admin') return
  if (user.role === 'lead' && user.departmentId === departmentId) return
  throw ApiError.forbidden('Заводить и менять услуги может руководитель отдела или админ')
}

// ---------------------------------------------------------------------------
// Клиенты в архиве
// ---------------------------------------------------------------------------

/**
 * Карточки клиентов для вкладки отдела.
 *
 * Клиент попадает во вкладку отдела, если у него есть услуга этого отдела —
 * или если услуг нет вовсе. Второе важно: только что занесённый клиент ещё
 * не привязан ни к какому отделу, и без этого правила руководителю было бы
 * негде завести ему первую услугу.
 */
export async function listArchiveClients(user, { departmentId, q } = {}) {
  const dept = resolveDepartment(user, departmentId)

  const where = {}
  if (dept) {
    where.OR = [
      { services: { some: { departmentId: dept } } },
      { services: { none: {} } },
    ]
  }
  if (q) where.client = { name: { contains: q, mode: 'insensitive' } }

  const rows = await prisma.archiveClient.findMany({
    where,
    include: {
      client: { select: { id: true, name: true } },
      addedBy: { select: PERSON },
      services: {
        where: dept ? { departmentId: dept } : undefined,
        select: {
          id: true,
          title: true,
          department: { select: { id: true, name: true } },
          _count: { select: { reports: true } },
          // Дата последнего отчёта по услуге — чтобы показать на карточке,
          // когда с клиентом работали в последний раз.
          reports: { select: { workedAt: true }, orderBy: { workedAt: 'desc' }, take: 1 },
        },
        orderBy: { title: 'asc' },
      },
    },
    orderBy: { client: { name: 'asc' } },
  })

  return rows.map((r) => {
    const reportCount = r.services.reduce((n, s) => n + s._count.reports, 0)
    const dates = r.services.map((s) => s.reports[0]?.workedAt).filter(Boolean)
    return {
      id: r.id,
      client: r.client,
      addedBy: r.addedBy,
      departments: dedupeById(r.services.map((s) => s.department)),
      serviceCount: r.services.length,
      reportCount,
      lastReportAt: dates.length ? new Date(Math.max(...dates.map((d) => d.getTime()))) : null,
    }
  })
}

const dedupeById = (list) => [...new Map(list.map((x) => [x.id, x])).values()]

/**
 * Карточка целиком: услуги видимого отдела и отчёты внутри них.
 *
 * Права проверяются по тому же правилу, что и список, иначе прямой запрос
 * по id оказался бы щедрее вкладки: сотрудник чужого отдела не нашёл бы
 * клиента в списке, но, подобрав ссылку, узнал бы, что тот в архиве есть.
 * Отвечаем «не найден», а не «нет прав» — так ответ ничего не подтверждает.
 */
export async function getArchiveClient(user, id) {
  const row = await prisma.archiveClient.findUnique({
    where: { id },
    include: {
      client: { select: { id: true, name: true } },
      addedBy: { select: PERSON },
      services: {
        include: {
          department: { select: { id: true, name: true } },
          createdBy: { select: PERSON },
          reports: {
            select: {
              id: true, fileName: true, fileSize: true, workedAt: true, createdAt: true,
              author: { select: PERSON },
            },
            orderBy: { workedAt: 'desc' },
          },
        },
        orderBy: { title: 'asc' },
      },
    },
  })

  if (!row) throw ApiError.notFound('Клиент в архиве не найден')
  if (user.role === 'admin') return row

  if (!user.departmentId) throw ApiError.forbidden('Вы не привязаны к отделу, поэтому архив недоступен')

  const mine = row.services.filter((s) => s.departmentId === user.departmentId)
  // Клиента без единой услуги видно всем: только так руководитель может
  // завести ему первую. А вот клиент, которым занимались только другие
  // отделы, для этого сотрудника не существует.
  if (row.services.length > 0 && mine.length === 0) {
    throw ApiError.notFound('Клиент в архиве не найден')
  }

  return { ...row, services: mine }
}

export async function addArchiveClient(user, clientId) {
  if (!['admin', 'lead'].includes(user.role)) {
    throw ApiError.forbidden('Заносить клиентов в архив может руководитель или админ')
  }

  const client = await prisma.client.findUnique({ where: { id: clientId } })
  if (!client) throw ApiError.notFound('Клиент не найден')

  try {
    return await prisma.archiveClient.create({
      data: { clientId, addedById: user.id },
      include: { client: { select: { id: true, name: true } } },
    })
  } catch (e) {
    if (e.code === 'P2002') throw ApiError.conflict('Этот клиент уже в архиве')
    throw e
  }
}

/**
 * Убрать клиента из архива вместе со всеми услугами и отчётами. Только
 * админ: это единственное действие, которое уничтожает историю целиком.
 */
export async function removeArchiveClient(user, id) {
  if (user.role !== 'admin') throw ApiError.forbidden('Убирать клиента из архива может только админ')

  const keys = await prisma.archiveReport.findMany({
    where: { service: { archiveClientId: id } },
    select: { fileKey: true },
  })

  try {
    await prisma.archiveClient.delete({ where: { id } })
  } catch (e) {
    if (e.code === 'P2025') throw ApiError.notFound('Клиент в архиве не найден')
    throw e
  }

  // Сначала база, потом файлы: если хранилище недоступно, в нём останется
  // мусор, который можно убрать позже. Обратный порядок оставил бы записи,
  // ссылающиеся в пустоту, — это пользователь увидит сразу.
  for (const k of keys) await deleteObject(k.fileKey)
  return { deletedReports: keys.length }
}

// ---------------------------------------------------------------------------
// Услуги
// ---------------------------------------------------------------------------

export async function createService(user, { archiveClientId, departmentId, title }) {
  assertCanManageServices(user, departmentId)

  const [archiveClient, department] = await Promise.all([
    prisma.archiveClient.findUnique({ where: { id: archiveClientId } }),
    prisma.department.findUnique({ where: { id: departmentId } }),
  ])
  if (!archiveClient) throw ApiError.notFound('Клиент в архиве не найден')
  if (!department) throw ApiError.notFound('Отдел не найден')

  return prisma.archiveService.create({
    data: { archiveClientId, departmentId, title, createdById: user.id },
    include: { department: { select: { id: true, name: true } }, createdBy: { select: PERSON } },
  })
}

export async function editService(user, id, { title }) {
  const service = await prisma.archiveService.findUnique({ where: { id } })
  if (!service) throw ApiError.notFound('Услуга не найдена')
  assertCanManageServices(user, service.departmentId)

  return prisma.archiveService.update({
    where: { id },
    data: { title },
    include: { department: { select: { id: true, name: true } } },
  })
}

export async function deleteService(user, id) {
  const service = await prisma.archiveService.findUnique({
    where: { id },
    include: { reports: { select: { fileKey: true } } },
  })
  if (!service) throw ApiError.notFound('Услуга не найдена')
  assertCanManageServices(user, service.departmentId)

  // Удалить услугу вместе с отчётами может только админ. Руководителю
  // оставлена возможность исправить опечатку и убрать лишнее, но потеря
  // накопленной истории — не его уровень.
  if (service.reports.length > 0 && user.role !== 'admin') {
    throw ApiError.badRequest(
      `Под услугой уже ${reportsWord(service.reports.length)} — удалить её может только админ`,
    )
  }

  await prisma.archiveService.delete({ where: { id } })
  for (const r of service.reports) await deleteObject(r.fileKey)
  return { deletedReports: service.reports.length }
}

// ---------------------------------------------------------------------------
// Отчёты
// ---------------------------------------------------------------------------

/** Поиск по отчётам — второй режим вкладки, «найти нужный», а не «открыть клиента». */
export async function listReports(user, { departmentId, clientId, serviceId, authorId, from, to, q, limit = 30, offset = 0 } = {}) {
  const dept = resolveDepartment(user, departmentId)

  const serviceWhere = {}
  if (dept) serviceWhere.departmentId = dept
  if (clientId) serviceWhere.archiveClient = { clientId }
  if (serviceId) serviceWhere.id = serviceId

  const where = { service: serviceWhere }
  if (authorId) where.authorId = authorId
  if (from || to) {
    where.workedAt = {}
    if (from) where.workedAt.gte = from
    if (to) where.workedAt.lte = to
  }
  if (q) {
    where.OR = [
      { fileName: { contains: q, mode: 'insensitive' } },
      // Текст, вытащенный из PDF при загрузке. Ради него поиск и работает
      // по содержимому, а не только по названиям.
      { textContent: { contains: q, mode: 'insensitive' } },
      { service: { title: { contains: q, mode: 'insensitive' } } },
      { service: { archiveClient: { client: { name: { contains: q, mode: 'insensitive' } } } } },
    ]
  }

  const [items, total] = await Promise.all([
    prisma.archiveReport.findMany({
      where,
      // textContent наружу не отдаём: он может весить сотни килобайт и
      // пользователю не нужен — содержимое он открывает в самом PDF.
      select: {
        id: true, fileName: true, fileSize: true, workedAt: true, createdAt: true,
        author: { select: PERSON },
        service: {
          select: {
            id: true, title: true,
            department: { select: { id: true, name: true } },
            archiveClient: { select: { id: true, client: { select: { id: true, name: true } } } },
          },
        },
      },
      orderBy: [{ workedAt: 'desc' }, { createdAt: 'desc' }],
      take: limit,
      skip: offset,
    }),
    prisma.archiveReport.count({ where }),
  ])

  return { items, total }
}

/**
 * Авторы для выпадающего списка фильтра.
 *
 * Берём из самих отчётов, а не из справочника сотрудников: тот закрыт для
 * staff и скрывает уволенных, а отчёты ушедших людей в архиве остаются и
 * обязаны находиться.
 */
export async function listReportAuthors(user, departmentId) {
  const dept = resolveDepartment(user, departmentId)

  const rows = await prisma.archiveReport.findMany({
    where: dept ? { service: { departmentId: dept } } : {},
    select: { author: { select: PERSON } },
    distinct: ['authorId'],
  })

  return rows.map((r) => r.author).sort((a, b) => a.name.localeCompare(b.name, 'ru'))
}

/** Вытащить текст для поиска. Скан или битый файл — не повод отказывать в загрузке. */
async function extractPdfText(buffer) {
  try {
    const pdf = await getDocumentProxy(new Uint8Array(buffer))
    const { text } = await extractText(pdf, { mergePages: true })
    const clean = String(text || '').replace(/\s+/g, ' ').trim()
    return clean ? clean.slice(0, MAX_TEXT_CHARS) : null
  } catch (e) {
    console.error('[архив] текст из PDF не извлечён:', e.message)
    return null
  }
}

export async function uploadReport(user, { serviceId, workedAt, file }) {
  const service = await prisma.archiveService.findUnique({ where: { id: serviceId } })
  if (!service) throw ApiError.notFound('Услуга не найдена')

  // Заливать отчёт может любой сотрудник, но только в услугу своего отдела.
  assertDepartmentVisible(user, service.departmentId)

  // Тип, который прислал браузер, задаётся отправителем и ничего не
  // доказывает. Настоящий PDF начинается с %PDF- — проверяем содержимое,
  // иначе в хранилище уедет что угодно под видом отчёта.
  if (file.buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw ApiError.badRequest('Это не PDF — внутри файла другое содержимое')
  }

  const key = `archive/${randomUUID()}.pdf`
  const textContent = await extractPdfText(file.buffer)

  await putObject(key, file.buffer, 'application/pdf')

  try {
    return await prisma.archiveReport.create({
      data: {
        serviceId,
        authorId: user.id,
        fileKey: key,
        fileName: file.originalname,
        fileSize: file.size,
        workedAt: workedAt || new Date(),
        textContent,
      },
      select: {
        id: true, fileName: true, fileSize: true, workedAt: true, createdAt: true,
        author: { select: PERSON },
      },
    })
  } catch (e) {
    // Файл уже в хранилище, а записи не будет — убираем за собой, иначе
    // он останется там навсегда никому не известным.
    await deleteObject(key)
    throw e
  }
}

/** Файл отдаётся потоком через наш сервер — проверка отдела происходит до выдачи. */
export async function getReportFile(user, id) {
  const report = await prisma.archiveReport.findUnique({
    where: { id },
    select: { fileKey: true, fileName: true, service: { select: { departmentId: true } } },
  })
  if (!report) throw ApiError.notFound('Отчёт не найден')
  assertDepartmentVisible(user, report.service.departmentId)

  const stream = await getObjectStream(report.fileKey)
  return { stream, fileName: report.fileName }
}

export async function deleteReport(user, id) {
  const report = await prisma.archiveReport.findUnique({
    where: { id },
    select: { fileKey: true, authorId: true, service: { select: { departmentId: true } } },
  })
  if (!report) throw ApiError.notFound('Отчёт не найден')

  const isAuthor = report.authorId === user.id
  const isLeadHere = user.role === 'lead' && user.departmentId === report.service.departmentId
  if (!isAuthor && !isLeadHere && user.role !== 'admin') {
    throw ApiError.forbidden('Удалить отчёт может автор, руководитель отдела или админ')
  }

  await prisma.archiveReport.delete({ where: { id } })
  await deleteObject(report.fileKey)
}
