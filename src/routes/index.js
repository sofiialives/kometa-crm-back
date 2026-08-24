import { Router } from 'express'
import authRoutes from './auth.routes.js'
import userRoutes from './user.routes.js'
import departmentRoutes from './department.routes.js'
import workRoutes from './work.routes.js'
import taskRoutes from './task.routes.js'
import clientRoutes from './client.routes.js'

const router = Router()

router.use('/auth', authRoutes)
router.use('/users', userRoutes)
router.use('/departments', departmentRoutes)
router.use('/works', workRoutes)
router.use('/tasks', taskRoutes)
router.use('/clients', clientRoutes)

export default router
