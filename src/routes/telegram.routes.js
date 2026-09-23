import { Router } from 'express'
import { authenticate } from '../middlewares/auth.middleware.js'
import * as telegramController from '../controllers/telegram.controller.js'

const router = Router()

router.use(authenticate)

// Каждый подключает только свой телеграм: userId берётся из токена, а не
// из тела запроса, поэтому подставить чужой нельзя.
router.get('/', telegramController.getStatus)
router.post('/code', telegramController.issueCode)
router.delete('/', telegramController.unlink)

export default router
