import { asyncHandler } from '../utils/asyncHandler.js'
import * as khochuPlachuService from '../services/khochuPlachu.service.js'

const MIME_BY_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp' }
function guessImageMime(fileName) {
  const ext = String(fileName).split('.').pop()?.toLowerCase()
  return MIME_BY_EXT[ext] || 'application/octet-stream'
}

export const listAmbassadors = asyncHandler(async (req, res) => {
  res.json(await khochuPlachuService.listAmbassadors(req.khochuPlachu, req.query))
})

export const listThemes = asyncHandler(async (req, res) => {
  res.json(await khochuPlachuService.listThemes(req.khochuPlachu.departmentId))
})

export const createAmbassador = asyncHandler(async (req, res) => {
  res.status(201).json(await khochuPlachuService.createAmbassador(req.khochuPlachu, req.body, req.files))
})

export const addScreenshots = asyncHandler(async (req, res) => {
  res.status(201).json(await khochuPlachuService.addScreenshots(req.khochuPlachu, req.params.id, req.files))
})

export const removeScreenshot = asyncHandler(async (req, res) => {
  res.json(await khochuPlachuService.removeScreenshot(req.khochuPlachu, req.params.id, req.params.screenshotId))
})

export const getScreenshotFile = asyncHandler(async (req, res) => {
  const { stream, fileName } = await khochuPlachuService.getScreenshotFile(req.khochuPlachu, req.params.id, req.params.screenshotId)
  res.setHeader('Content-Type', guessImageMime(fileName))
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`)
  stream.on('error', (e) => {
    console.error('[хочу плачу] обрыв при отдаче скрина:', e.message)
    res.destroy()
  })
  stream.pipe(res)
})

export const decideAmbassador = asyncHandler(async (req, res) => {
  res.json(await khochuPlachuService.decideAmbassador(req.khochuPlachu, req.params.id, req.body.decision))
})

export const removeFromApproved = asyncHandler(async (req, res) => {
  res.json(await khochuPlachuService.removeFromApproved(req.khochuPlachu, req.params.id))
})

export const unreadCount = asyncHandler(async (req, res) => {
  res.json({ count: await khochuPlachuService.getUnreadCount(req.khochuPlachu.userId) })
})

export const markNotificationsRead = asyncHandler(async (req, res) => {
  res.json(await khochuPlachuService.markNotificationsRead(req.khochuPlachu.userId))
})

export const getAnalytics = asyncHandler(async (req, res) => {
  res.json(await khochuPlachuService.getAnalytics(req.khochuPlachu.departmentId))
})
