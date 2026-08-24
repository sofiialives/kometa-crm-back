import { Router } from 'express'
import { validate } from '../middlewares/validate.middleware.js'
import { authenticate, authorize } from '../middlewares/auth.middleware.js'
import { createClientSchema, updateClientSchema, clientIdParamSchema } from '../schemas/client.schema.js'
import * as clientController from '../controllers/client.controller.js'

const router = Router()

router.use(authenticate)

// Список открыт и lead — ему тоже нужно выбирать клиента при создании
// работы в своём отделе, не только админу.
router.get('/', clientController.listClients)
router.post('/', authorize('admin'), validate(createClientSchema), clientController.createClient)
router.patch('/:id', authorize('admin'), validate(updateClientSchema), clientController.updateClient)
router.delete('/:id', authorize('admin'), validate(clientIdParamSchema), clientController.deleteClient)

export default router
