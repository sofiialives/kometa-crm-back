import { randomUUID } from 'node:crypto'
import { prisma } from '../config/prisma.js'
import { ApiError } from '../utils/ApiError.js'
import { deleteObject, getObjectStream, putObject } from '../utils/storage.js'
import { escapeHtml, sendMessage } from '../bot/telegram.js'
import { tellOwners } from '../bot/agent/notify.js'

export const DEPARTMENT_NAME = 'Хочу Плачу фокус'
export const MANAGER_POSITION = 'Менеджер'
export const ACCOUNT_MANAGER_POSITION = 'Аккаунт менеджер'

const PERSON = { id: true, name: true, avatarUrl: true, avatarColor: true }

const REPORT_INCLUDE = {
  manager: { select: PERSON },
  decidedBy: { select: PERSON },
  links: { orderBy: { createdAt: 'asc' } },
  screenshots: { orderBy: { createdAt: 'asc' } },
}

export async function resolveDepartmentId() {
  const department = await prisma.department.findUnique({ where: { name: DEPARTMENT_NAME } })
  return department?.id || null
}

export async function listAccountManagers(departmentId) {
  return prisma.user.findMany({
    where: { departmentId, position: ACCOUNT_MANAGER_POSITION, active: true },
    select: { id: true, name: true, telegram: { select: { chatId: true } } },
  })
}

function describeAmbassador(contactUsername, firstLink) {
  const base = escapeHtml(contactUsername)
  if (!firstLink) return base
  return `${base} (${escapeHtml(firstLink.label)}: ${escapeHtml(firstLink.url)})`
}

export async function listAmbassadors(access, { q, theme, status, fromDate, toDate } = {}) {
  const where = { departmentId: access.departmentId }

  const safeStatus = status && status !== 'rejected' ? status : { not: 'rejected' }
  where.status = safeStatus

  if (access.scope === 'manager') where.managerId = access.userId

  if (fromDate || toDate) {
    where.createdAt = {}
    if (fromDate) where.createdAt.gte = new Date(`${fromDate}T00:00:00.000`)
    if (toDate) where.createdAt.lte = new Date(`${toDate}T23:59:59.999`)
  }

  if (theme) where.theme = theme
  if (q) {
    where.OR = [
      { theme: { contains: q, mode: 'insensitive' } },
      { conditions: { contains: q, mode: 'insensitive' } },
      { contactUsername: { contains: q, mode: 'insensitive' } },
      { telegramGroupLink: { contains: q, mode: 'insensitive' } },
      { manager: { name: { contains: q, mode: 'insensitive' } } },
    ]
  }

  return prisma.ambassadorReport.findMany({
    where,
    include: REPORT_INCLUDE,
    orderBy: { createdAt: 'desc' },
  })
}

export async function listThemes(departmentId) {
  const rows = await prisma.ambassadorReport.findMany({
    where: { departmentId, theme: { not: '' } },
    select: { theme: true },
    distinct: ['theme'],
  })
  return rows.map((r) => r.theme).sort((a, b) => a.localeCompare(b, 'ru'))
}

export async function createAmbassador(access, body, files) {
  const uploaded = []
  try {
    for (const file of files || []) {
      const key = `khochu-plachu/${randomUUID()}-${file.originalname}`
      await putObject(key, file.buffer, file.mimetype)
      uploaded.push({ key, fileName: file.originalname, fileSize: file.size })
    }

    const accountManagers = await listAccountManagers(access.departmentId)

    const report = await prisma.$transaction(async (tx) => {
      const created = await tx.ambassadorReport.create({
        data: {
          departmentId: access.departmentId,
          managerId: access.userId,
          theme: body.theme,
          conditions: body.conditions,
          managerComment: body.managerComment || null,
          callAt: body.callAt || null,
          telegramGroupLink: body.telegramGroupLink,
          contactUsername: body.contactUsername,
          links: { create: body.links },
          screenshots: { create: uploaded.map((u) => ({ fileKey: u.key, fileName: u.fileName, fileSize: u.fileSize })) },
        },
        include: REPORT_INCLUDE,
      })

      await tx.ambassadorStatusLog.create({
        data: { ambassadorReportId: created.id, fromStatus: null, toStatus: 'pending', actorId: access.userId },
      })

      if (accountManagers.length) {
        await tx.ambassadorNotification.createMany({
          data: accountManagers.map((m) => ({ ambassadorReportId: created.id, recipientId: m.id })),
        })
      }

      return created
    })

    const manager = await prisma.user.findUnique({ where: { id: access.userId }, select: { name: true } })
    const who = describeAmbassador(body.contactUsername, body.links?.[0])
    const text = `Менеджер ${escapeHtml(manager?.name || '')} добавил нового амбассадора ${who}, проверьте CRM`
    for (const m of accountManagers) {
      const chatId = m.telegram?.chatId
      if (!chatId) {
        console.error(`[хочу плачу] у аккаунт-менеджера ${m.id} нет привязанного телеграма — уведомление о заявке не отправлено`)
        continue
      }
      sendMessage(chatId, text).catch((e) => console.error('[хочу плачу] уведомление в телеграм не ушло:', e.message))
    }

    const accountManagerNames = accountManagers.map((m) => escapeHtml(m.name || '')).join(', ') || 'нет назначенных'
    tellOwners(`<b>Хочу Плачу: новая заявка</b>\nМенеджер ${escapeHtml(manager?.name || '')} передал амбассадора ${who} на рассмотрение аккаунт-менеджеру: ${accountManagerNames}`)
      .catch((e) => console.error('[хочу плачу] лог для владельца не ушёл:', e.message))

    return report
  } catch (e) {
    for (const u of uploaded) await deleteObject(u.key)
    throw e
  }
}

export async function addScreenshots(access, id, files) {
  if (!files?.length) throw ApiError.badRequest('Прикрепите хотя бы один файл')
  const report = await getOwnedReport(access, id)
  if (report.status !== 'pending') throw ApiError.badRequest('Заявка уже рассмотрена')

  const uploaded = []
  try {
    for (const file of files) {
      const key = `khochu-plachu/${randomUUID()}-${file.originalname}`
      await putObject(key, file.buffer, file.mimetype)
      uploaded.push({ key, fileName: file.originalname, fileSize: file.size })
    }
    await prisma.ambassadorScreenshot.createMany({
      data: uploaded.map((u) => ({ ambassadorReportId: report.id, fileKey: u.key, fileName: u.fileName, fileSize: u.fileSize })),
    })
    return prisma.ambassadorReport.findUnique({ where: { id }, include: REPORT_INCLUDE })
  } catch (e) {
    for (const u of uploaded) await deleteObject(u.key)
    throw e
  }
}

export async function removeScreenshot(access, id, screenshotId) {
  await getOwnedReport(access, id)
  const screenshot = await prisma.ambassadorScreenshot.findUnique({ where: { id: screenshotId } })
  if (!screenshot || screenshot.ambassadorReportId !== id) throw ApiError.notFound('Скриншот не найден')

  await prisma.ambassadorScreenshot.delete({ where: { id: screenshotId } })
  await deleteObject(screenshot.fileKey)
  return prisma.ambassadorReport.findUnique({ where: { id }, include: REPORT_INCLUDE })
}

async function getOwnedReport(access, id) {
  const report = await prisma.ambassadorReport.findUnique({ where: { id } })
  if (!report || report.departmentId !== access.departmentId) throw ApiError.notFound('Амбассадор не найден')
  if (report.managerId !== access.userId) throw ApiError.forbidden('Изменить может только автор заявки')
  return report
}

export async function getScreenshotFile(access, id, screenshotId) {
  const report = await prisma.ambassadorReport.findUnique({ where: { id } })
  if (!report || report.departmentId !== access.departmentId) throw ApiError.notFound('Амбассадор не найден')
  if (access.scope === 'manager' && report.managerId !== access.userId) throw ApiError.forbidden('Доступно только автору заявки')

  const screenshot = await prisma.ambassadorScreenshot.findUnique({ where: { id: screenshotId } })
  if (!screenshot || screenshot.ambassadorReportId !== id) throw ApiError.notFound('Скриншот не найден')

  const stream = await getObjectStream(screenshot.fileKey)
  return { stream, fileName: screenshot.fileName }
}

export async function decideAmbassador(access, id, decision) {
  const report = await prisma.ambassadorReport.findUnique({
    where: { id },
    include: {
      manager: { include: { telegram: true } },
      links: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 1 },
      screenshots: true,
    },
  })
  if (!report || report.departmentId !== access.departmentId) throw ApiError.notFound('Амбассадор не найден')
  if (report.status !== 'pending') throw ApiError.badRequest('Заявка уже рассмотрена')

  const who = describeAmbassador(report.contactUsername, report.links[0])

  const updated = await prisma.$transaction(async (tx) => {
    const next = await tx.ambassadorReport.update({
      where: { id },
      data: { status: decision, decidedById: access.userId, decidedAt: new Date() },
      include: REPORT_INCLUDE,
    })
    await tx.ambassadorStatusLog.create({
      data: { ambassadorReportId: id, fromStatus: 'pending', toStatus: decision, actorId: access.userId },
    })
    return next
  })

  const decider = await prisma.user.findUnique({ where: { id: access.userId }, select: { name: true } })
  const verb = decision === 'approved' ? 'одобрил(а)' : 'отклонил(а)'

  const chatId = report.manager.telegram?.chatId
  if (chatId) {
    const text = `Аккаунт-менеджер ${escapeHtml(decider?.name || '')} ${verb} вашего амбассадора ${who}`
    sendMessage(chatId, text).catch((e) => console.error('[хочу плачу] уведомление в телеграм не ушло:', e.message))
  } else {
    console.error(`[хочу плачу] у менеджера ${report.managerId} нет привязанного телеграма — решение не отправлено`)
  }

  tellOwners(`<b>Хочу Плачу: решение</b>\nАккаунт-менеджер ${escapeHtml(decider?.name || '')} ${verb} амбассадора ${who} (менеджер ${escapeHtml(report.manager.name || '')})`)
    .catch((e) => console.error('[хочу плачу] лог для владельца не ушёл:', e.message))

  if (decision === 'rejected') return purgeRejected(id, report.screenshots)

  return updated
}

async function purgeRejected(id, screenshots) {
  for (const s of screenshots) await deleteObject(s.fileKey)

  return prisma.$transaction(async (tx) => {
    await tx.ambassadorScreenshot.deleteMany({ where: { ambassadorReportId: id } })
    await tx.ambassadorLink.deleteMany({ where: { ambassadorReportId: id } })
    return tx.ambassadorReport.update({
      where: { id },
      data: { theme: '', conditions: '', managerComment: null, telegramGroupLink: '', contactUsername: '' },
      include: REPORT_INCLUDE,
    })
  })
}

export async function removeFromApproved(access, id) {
  const report = await prisma.ambassadorReport.findUnique({
    where: { id },
    include: { manager: { select: { name: true } }, links: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 1 } },
  })
  if (!report || report.departmentId !== access.departmentId) throw ApiError.notFound('Амбассадор не найден')
  if (report.status !== 'approved') throw ApiError.badRequest('Снять можно только одобренного амбассадора')

  const who = describeAmbassador(report.contactUsername, report.links[0])

  const updated = await prisma.$transaction(async (tx) => {
    const next = await tx.ambassadorReport.update({
      where: { id },
      data: { status: 'removed', decidedById: access.userId, decidedAt: new Date() },
      include: REPORT_INCLUDE,
    })
    await tx.ambassadorStatusLog.create({
      data: { ambassadorReportId: id, fromStatus: 'approved', toStatus: 'removed', actorId: access.userId },
    })
    return next
  })

  const actor = await prisma.user.findUnique({ where: { id: access.userId }, select: { name: true } })
  tellOwners(`<b>Хочу Плачу: снят с одобренных</b>\nАккаунт-менеджер ${escapeHtml(actor?.name || '')} снял(а) амбассадора ${who} (менеджер ${escapeHtml(report.manager.name || '')}) с одобренных`)
    .catch((e) => console.error('[хочу плачу] лог для владельца не ушёл:', e.message))

  return updated
}

export async function getUnreadCount(userId) {
  return prisma.ambassadorNotification.count({ where: { recipientId: userId, read: false } })
}

export async function markNotificationsRead(userId) {
  await prisma.ambassadorNotification.updateMany({ where: { recipientId: userId, read: false }, data: { read: true } })
  return { ok: true }
}

async function countStatusLogs(where) {
  const rows = await prisma.ambassadorStatusLog.groupBy({ by: ['toStatus'], where, _count: { _all: true } })
  const added = await prisma.ambassadorStatusLog.count({ where: { ...where, fromStatus: null } })
  const map = Object.fromEntries(rows.map((r) => [r.toStatus, r._count._all]))
  return {
    added,
    approved: map.approved || 0,
    rejected: map.rejected || 0,
    removed: map.removed || 0,
  }
}

export async function getAnalytics(departmentId) {
  const monthStart = new Date()
  monthStart.setDate(1)
  monthStart.setHours(0, 0, 0, 0)

  const base = { ambassadorReport: { departmentId } }
  const [month, allTime] = await Promise.all([
    countStatusLogs({ ...base, createdAt: { gte: monthStart } }),
    countStatusLogs(base),
  ])
  return { month, allTime }
}
