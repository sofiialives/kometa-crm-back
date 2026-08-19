import { Router } from 'express'
import { validate } from '../middlewares/validate.middleware.js'
import { authenticate } from '../middlewares/auth.middleware.js'
import { loginSchema, googleLoginSchema, refreshSchema } from '../schemas/auth.schema.js'
import * as authController from '../controllers/auth.controller.js'

const router = Router()

router.post('/login', validate(loginSchema), authController.login)
router.post('/google', validate(googleLoginSchema), authController.loginGoogle)
router.post('/refresh', validate(refreshSchema), authController.refresh)
router.post('/logout', authController.logout)
router.get('/me', authenticate, authController.me)

export default router
