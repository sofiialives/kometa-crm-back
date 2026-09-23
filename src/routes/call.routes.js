import { Router } from 'express'
import { validate } from '../middlewares/validate.middleware.js'
import { authenticate } from '../middlewares/auth.middleware.js'
import {
  listCallsQuerySchema, createCallSchema, editCallSchema, callIdParamSchema,
} from '../schemas/call.schema.js'
import * as callController from '../controllers/call.controller.js'

const router = Router()

router.use(authenticate)

router.get('/', validate(listCallsQuerySchema), callController.listCalls)
router.post('/', validate(createCallSchema), callController.createCall)
router.patch('/:id', validate(editCallSchema), callController.editCall)
router.delete('/:id', validate(callIdParamSchema), callController.deleteCall)

export default router
