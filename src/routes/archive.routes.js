import { Router } from 'express'
import multer from 'multer'
import { validate } from '../middlewares/validate.middleware.js'
import { authenticate } from '../middlewares/auth.middleware.js'
import { ApiError } from '../utils/ApiError.js'
import { env } from '../config/env.js'
import {
  addArchiveClientSchema, archiveIdParamSchema, createServiceSchema, editServiceSchema,
  listArchiveClientsSchema, listReportAuthorsSchema, listReportsQuerySchema, uploadReportSchema,
} from '../schemas/archive.schema.js'
import * as archiveController from '../controllers/archive.controller.js'

const router = Router()

router.use(authenticate)

/**
 * Файл держим в памяти, а не в файле на диске: он всё равно нужен целиком
 * и для отправки в хранилище, и для извлечения текста. При потолке в 20 МБ
 * это безопасно даже на маленьком сервере.
 */
const multipart = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.maxReportBytes, files: 1, fields: 10 },
  // Имена файлов у нас русские, а multer по умолчанию читает их как
  // latin1 — «Отчёт.pdf» превращался в «ÐÑÑÑÑ.pdf» и таким и сохранялся
  // в базу. Браузеры отправляют имя в UTF-8, ему и верим.
  defParamCharset: 'utf8',
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'application/pdf') {
      return cb(ApiError.badRequest('Принимаются только PDF'))
    }
    cb(null, true)
  },
}).single('file')

/**
 * Свои ошибки multer (слишком большой файл, лишние поля) — это ошибки
 * пользователя, а не сбой сервера. Без этой обёртки они дошли бы до
 * обработчика как пятисотые и выглядели бы поломкой.
 */
function uploadPdf(req, res, next) {
  multipart(req, res, (err) => {
    if (!err) return next()
    if (err instanceof ApiError) return next(err)
    if (err.code === 'LIMIT_FILE_SIZE') {
      const mb = Math.round(env.maxReportBytes / (1024 * 1024))
      return next(ApiError.badRequest(`Файл больше ${mb} МБ — столько мы не принимаем`))
    }
    next(ApiError.badRequest(err.message || 'Файл не принят'))
  })
}

// Клиенты в архиве
router.get('/clients', validate(listArchiveClientsSchema), archiveController.listClients)
router.get('/clients/:id', validate(archiveIdParamSchema), archiveController.getClient)
router.post('/clients', validate(addArchiveClientSchema), archiveController.addClient)
router.delete('/clients/:id', validate(archiveIdParamSchema), archiveController.removeClient)

// Услуги
router.post('/services', validate(createServiceSchema), archiveController.createService)
router.patch('/services/:id', validate(editServiceSchema), archiveController.editService)
router.delete('/services/:id', validate(archiveIdParamSchema), archiveController.deleteService)

// Отчёты
router.get('/reports', validate(listReportsQuerySchema), archiveController.listReports)
router.get('/authors', validate(listReportAuthorsSchema), archiveController.listAuthors)
// Разбор формы идёт до проверки полей: тело запроса появляется только
// после multer, до него validate увидел бы пустоту.
router.post('/reports', uploadPdf, validate(uploadReportSchema), archiveController.uploadReport)
router.get('/reports/:id/file', validate(archiveIdParamSchema), archiveController.downloadReport)
router.delete('/reports/:id', validate(archiveIdParamSchema), archiveController.deleteReport)

export default router
