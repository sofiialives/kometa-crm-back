import { Router } from 'express'
import { validate } from '../middlewares/validate.middleware.js'
import { authenticate } from '../middlewares/auth.middleware.js'
import { createTaskSchema, updateTaskStatusSchema, listTasksQuerySchema } from '../schemas/task.schema.js'
import * as taskController from '../controllers/task.controller.js'

const router = Router()

router.use(authenticate)

router.get('/', validate(listTasksQuerySchema), taskController.listTasks)
router.post('/', validate(createTaskSchema), taskController.createTask)
router.patch('/:id/status', validate(updateTaskStatusSchema), taskController.updateTaskStatus)
router.delete('/:id', taskController.deleteTask)

export default router
