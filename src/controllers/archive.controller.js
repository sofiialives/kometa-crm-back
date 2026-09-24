import { asyncHandler } from '../utils/asyncHandler.js'
import { ApiError } from '../utils/ApiError.js'
import * as archiveService from '../services/archive.service.js'

export const listClients = asyncHandler(async (req, res) => {
  res.json(await archiveService.listArchiveClients(req.user, req.query))
})

export const getClient = asyncHandler(async (req, res) => {
  res.json(await archiveService.getArchiveClient(req.user, req.params.id))
})

export const addClient = asyncHandler(async (req, res) => {
  res.status(201).json(await archiveService.addArchiveClient(req.user, req.body.clientId))
})

export const removeClient = asyncHandler(async (req, res) => {
  res.json(await archiveService.removeArchiveClient(req.user, req.params.id))
})

export const createService = asyncHandler(async (req, res) => {
  res.status(201).json(await archiveService.createService(req.user, req.body))
})

export const editService = asyncHandler(async (req, res) => {
  res.json(await archiveService.editService(req.user, req.params.id, req.body))
})

export const deleteService = asyncHandler(async (req, res) => {
  res.json(await archiveService.deleteService(req.user, req.params.id))
})

export const listReports = asyncHandler(async (req, res) => {
  res.json(await archiveService.listReports(req.user, req.query))
})

export const listAuthors = asyncHandler(async (req, res) => {
  res.json(await archiveService.listReportAuthors(req.user, req.query.departmentId))
})

export const listServiceTitles = asyncHandler(async (req, res) => {
  res.json(await archiveService.listServiceTitles(req.user, req.query.departmentId))
})

export const uploadReport = asyncHandler(async (req, res) => {
  if (!req.file) throw ApiError.badRequest('Файл отчёта не приложен')
  res.status(201).json(await archiveService.uploadReport(req.user, { ...req.body, file: req.file }))
})

/**
 * Отдаём файл потоком. inline, а не attachment: отчёты чаще открывают
 * почитать, чем скачивают, и лишний шаг «найти в загрузках» ни к чему.
 *
 * Имя файла почти всегда русское, поэтому кодируем по RFC 5987 — иначе
 * браузер получит мусор вместо названия.
 */
export const downloadReport = asyncHandler(async (req, res) => {
  const { stream, fileName } = await archiveService.getReportFile(req.user, req.params.id)

  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`)

  stream.on('error', (e) => {
    console.error('[архив] обрыв при отдаче файла:', e.message)
    res.destroy()
  })
  stream.pipe(res)
})

export const deleteReport = asyncHandler(async (req, res) => {
  await archiveService.deleteReport(req.user, req.params.id)
  res.status(204).send()
})
