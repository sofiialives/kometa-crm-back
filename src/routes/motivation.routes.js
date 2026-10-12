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
 * Роли на маршрутах — первая линия. Вторая — в сервисах: они сами
 * проверяют, кто кого видит и кем управляет. Маршрут можно случайно открыть
 * шире, чем нужно, а проверку внутри сервиса так просто не забудешь.
 */

const router = Router()

router.use(authenticate)

// Сотрудник про себя. Руководителю и админу сервис ответит, что банка у
// них нет, — роль здесь не режем, чтобы этот ответ был понятным.
router.get('/me', validate(monthQuerySchema), c.getMine)
router.get('/me/conditions', c.getMyConditions)
router.post('/me/seen', validate(seenSchema), c.markSeen)

// Руководитель и админ.
const manager = authorize('admin', 'lead')
router.get('/team', manager, validate(teamQuerySchema), c.getTeam)
router.get('/team/months', manager, c.getTeamMonths)
router.get('/employees', manager, c.getEmployees)
router.get('/users/:id', manager, validate(userMonthSchema), c.getEmployee)
router.get('/users/:id/conditions', manager, validate(userIdParamSchema), c.getEmployeeConditions)
router.get('/users/:id/options', manager, validate(userIdParamSchema), c.getManualOptions)

router.post('/bank/top-up', manager, validate(topUpSchema), c.topUp)
router.post('/bank/write-off', authorize('admin'), validate(writeOffSchema), c.writeOff)

router.post('/events', manager, validate(manualEventSchema), c.addManual)
router.post('/events/product', manager, validate(productSchema), c.addProduct)
router.post('/events/:id/cancel', manager, validate(cancelEventSchema), c.cancelEvent)

// Настройки — только админ.
const admin = authorize('admin')
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
