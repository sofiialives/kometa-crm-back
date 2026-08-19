import { Router } from 'express'
import { validate } from '../middlewares/validate.middleware.js'
import { authenticate, authorize } from '../middlewares/auth.middleware.js'
import { createUserSchema, updateUserSchema, userIdParamSchema } from '../schemas/user.schema.js'
import * as userController from '../controllers/user.controller.js'

const router = Router()

router.use(authenticate)

router.get('/', authorize('admin', 'lead'), userController.listUsers)
router.post('/', authorize('admin'), validate(createUserSchema), userController.createUser)
router.patch('/:id', authorize('admin'), validate(updateUserSchema), userController.updateUser)
router.post('/:id/deactivate', authorize('admin'), validate(userIdParamSchema), userController.deactivateUser)

export default router
