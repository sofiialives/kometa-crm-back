import { Router } from 'express'
import multer from 'multer'
import { validate } from '../middlewares/validate.middleware.js'
import { authenticate } from '../middlewares/auth.middleware.js'
import { khochuPlachuAccess, khochuPlachuRequireAccountManager, khochuPlachuRequireManager } from '../middlewares/khochuPlachu.middleware.js'
import { ApiError } from '../utils/ApiError.js'
import {
  ambassadorIdParamSchema, createAmbassadorSchema, decideAmbassadorSchema,
  deleteScreenshotParamSchema, listAmbassadorsQuerySchema,
} from '../schemas/khochuPlachu.schema.js'
import * as khochuPlachuController from '../controllers/khochuPlachu.controller.js'

const router = Router()

router.use(authenticate, khochuPlachuAccess)

const multipart = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 10 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(ApiError.badRequest('Принимаются только изображения'))
    cb(null, true)
  },
}).array('screenshots', 10)

function uploadScreenshots(req, res, next) {
  multipart(req, res, (err) => {
    if (!err) return next()
    if (err instanceof ApiError) return next(err)
    if (err.code === 'LIMIT_FILE_SIZE') return next(ApiError.badRequest('Файл больше 15 МБ'))
    next(ApiError.badRequest(err.message || 'Файл не принят'))
  })
}

router.get('/ambassadors', validate(listAmbassadorsQuerySchema), khochuPlachuController.listAmbassadors)
router.get('/ambassadors/themes', khochuPlachuController.listThemes)
router.post('/ambassadors', khochuPlachuRequireManager, uploadScreenshots, validate(createAmbassadorSchema), khochuPlachuController.createAmbassador)
router.post('/ambassadors/:id/screenshots', khochuPlachuRequireManager, uploadScreenshots, validate(ambassadorIdParamSchema), khochuPlachuController.addScreenshots)
router.delete('/ambassadors/:id/screenshots/:screenshotId', khochuPlachuRequireManager, validate(deleteScreenshotParamSchema), khochuPlachuController.removeScreenshot)
router.get('/ambassadors/:id/screenshots/:screenshotId/file', validate(deleteScreenshotParamSchema), khochuPlachuController.getScreenshotFile)
router.post('/ambassadors/:id/decision', khochuPlachuRequireAccountManager, validate(decideAmbassadorSchema), khochuPlachuController.decideAmbassador)
router.post('/ambassadors/:id/remove', khochuPlachuRequireAccountManager, validate(ambassadorIdParamSchema), khochuPlachuController.removeFromApproved)
router.get('/notifications/unread-count', khochuPlachuRequireAccountManager, khochuPlachuController.unreadCount)
router.post('/notifications/read', khochuPlachuRequireAccountManager, khochuPlachuController.markNotificationsRead)
router.get('/analytics', khochuPlachuController.getAnalytics)

export default router
