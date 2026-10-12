import { Router } from 'express'
import { validate } from '../middlewares/validate.middleware.js'
import { authenticate, authorize } from '../middlewares/auth.middleware.js'
import {
  assignmentSchema, cancelEventSchema, createEventTypeSchema, createProfileSchema, generalSettingsSchema,
  globalScaleSchema, manualEventSchema, monthQuerySchema, productSchema, profileScaleSchema, seenSchema, teamQuerySchema,
  topUpSchema, updateEventTypeSchema, updateProfileSchema, userIdParamSchema, userMonthSchema, workLevelsSchema,
  writeOffSchema,
} from '../schemas/motivation.schema.js'
import * as c from '../controllers/motivation.controller.js'

/**
 * Вкладка «Мотивация».
 *
 * Свой банк и условия — у сотрудников и руководителей. Раздел «Команда»
 * смотрят руководитель (свой отдел) и владелец (всех). Всё, что меняет
 * деньги и баллы, и все настройки — только владелец.
 *
 * Роли на маршрутах — первая линия. Вторая — в сервисах: они сами
 * проверяют, кто кого видит и кем управляет. Маршрут можно случайно открыть
 * шире, чем нужно, а проверку внутри сервиса так просто не забудешь.
 */

const router = Router()

router.use(authenticate)

// Своя мотивация — у сотрудника и руководителя. Владельцу сервис ответит,
// что банка у него нет, — роль здесь не режем, чтобы ответ был понятным.
router.get('/me', validate(monthQuerySchema), c.getMine)
router.get('/me/conditions', c.getMyConditions)
router.post('/me/seen', validate(seenSchema), c.markSeen)

// Смотреть команду: руководитель и владелец.
const viewer = authorize('admin', 'lead')
router.get('/team', viewer, validate(teamQuerySchema), c.getTeam)
router.get('/team/months', viewer, c.getTeamMonths)
router.get('/users/:id', viewer, validate(userMonthSchema), c.getEmployee)
router.get('/users/:id/conditions', viewer, validate(userIdParamSchema), c.getEmployeeConditions)

// Менять деньги и баллы, и все настройки — только владелец.
const admin = authorize('admin')
router.get('/employees', admin, c.getEmployees)
router.get('/users/:id/options', admin, validate(userIdParamSchema), c.getManualOptions)

router.post('/bank/top-up', admin, validate(topUpSchema), c.topUp)
router.post('/bank/write-off', admin, validate(writeOffSchema), c.writeOff)

router.post('/events', admin, validate(manualEventSchema), c.addManual)
router.post('/events/product', admin, validate(productSchema), c.addProduct)
router.post('/events/:id/cancel', admin, validate(cancelEventSchema), c.cancelEvent)

router.get('/settings', admin, c.getSettings)
router.patch('/settings', admin, validate(generalSettingsSchema), c.updateGeneral)
router.put('/scale', admin, validate(globalScaleSchema), c.saveGlobalScale)
router.put('/work-levels', admin, validate(workLevelsSchema), c.saveWorkLevels)

router.post('/profiles', admin, validate(createProfileSchema), c.createProfile)
router.patch('/profiles/:id', admin, validate(updateProfileSchema), c.updateProfile)
router.delete('/profiles/:id', admin, validate(userIdParamSchema), c.deleteProfile)
router.put('/profiles/:id/scale', admin, validate(profileScaleSchema), c.saveProfileScale)
router.post('/profiles/:id/events', admin, validate(createEventTypeSchema), c.createEventType)

router.patch('/event-types/:id', admin, validate(updateEventTypeSchema), c.updateEventType)
router.delete('/event-types/:id', admin, validate(userIdParamSchema), c.deleteEventType)

router.put('/assignments/:userId', admin, validate(assignmentSchema), c.assignProfile)

export default router
