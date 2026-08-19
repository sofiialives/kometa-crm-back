import { Router } from 'express'
import { validate } from '../middlewares/validate.middleware.js'
import { authenticate, authorize } from '../middlewares/auth.middleware.js'
import { createWorkSchema, updateWorkSchema } from '../schemas/work.schema.js'
import * as workController from '../controllers/work.controller.js'

const router = Router()

router.use(authenticate)

router.get('/', workController.listWorks)
router.post('/', authorize('admin', 'lead'), validate(createWorkSchema), workController.createWork)
router.patch('/:id', authorize('admin', 'lead'), validate(updateWorkSchema), workController.updateWork)

export default router
