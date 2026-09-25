import { Router } from 'express'
import { validate } from '../middlewares/validate.middleware.js'
import { authenticate, authorize } from '../middlewares/auth.middleware.js'
import {
  addClientSchema, addServiceSchema, boardIdParamSchema, boardQuerySchema,
  cardQuerySchema, editClientSchema, editServiceSchema, leaveSchema,
} from '../schemas/board.schema.js'
import * as boardController from '../controllers/board.controller.js'

const router = Router()

// Доска целиком закрыта админом — это финансы всего агентства. Сервис
// проверяет это ещё раз сам: маршрут можно случайно открыть, а забыть
// проверку внутри сложнее.
router.use(authenticate, authorize('admin'))

router.get('/', validate(boardQuerySchema), boardController.getBoard)
router.get('/months', boardController.listMonths)
router.get('/clients/:id', validate(cardQuerySchema), boardController.getCard)

router.post('/clients', validate(addClientSchema), boardController.addClient)
router.patch('/clients/:id', validate(editClientSchema), boardController.editClient)
router.post('/clients/:id/leave', validate(leaveSchema), boardController.markLeft)
router.post('/clients/:id/return', validate(boardIdParamSchema), boardController.markActive)
router.delete('/clients/:id', validate(boardIdParamSchema), boardController.removeClient)

router.post('/services', validate(addServiceSchema), boardController.addService)
router.patch('/services/:id', validate(editServiceSchema), boardController.editService)
router.delete('/services/:id', validate(boardIdParamSchema), boardController.removeService)

export default router
