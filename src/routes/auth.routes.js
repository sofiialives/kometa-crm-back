import { Router } from 'express'
import { validate } from '../middlewares/validate.middleware.js'
import { authenticate } from '../middlewares/auth.middleware.js'
import {
  loginSchema, googleLoginSchema, refreshSchema,
  forgotPasswordSchema, resetPasswordSchema, updateMeSchema,
} from '../schemas/auth.schema.js'
import * as authController from '../controllers/auth.controller.js'

const router = Router()

router.post('/login', validate(loginSchema), authController.login)
router.post('/google', validate(googleLoginSchema), authController.loginGoogle)
router.post('/forgot-password', validate(forgotPasswordSchema), authController.forgotPassword)
router.post('/reset-password', validate(resetPasswordSchema), authController.resetPassword)
router.post('/refresh', validate(refreshSchema), authController.refresh)
router.post('/logout', authController.logout)
router.get('/me', authenticate, authController.me)
router.patch('/me', authenticate, validate(updateMeSchema), authController.updateMe)

export default router
