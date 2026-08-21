import { Router } from 'express'
import { validate } from '../middlewares/validate.middleware.js'
import { authenticate } from '../middlewares/auth.middleware.js'
import {
  createTaskSchema, updateTaskStatusSchema, listTasksQuerySchema,
  extendTaskDeadlineSchema, taskIdParamSchema, editTaskSchema,
} from '../schemas/task.schema.js'
import * as taskController from '../controllers/task.controller.js'

const router = Router()

router.use(authenticate)

router.get('/', validate(listTasksQuerySchema), taskController.listTasks)
router.post('/', validate(createTaskSchema), taskController.createTask)
router.patch('/:id', validate(editTaskSchema), taskController.editTask)
router.patch('/:id/status', validate(updateTaskStatusSchema), taskController.updateTaskStatus)
router.patch('/:id/deadline', validate(extendTaskDeadlineSchema), taskController.extendDeadline)
router.delete('/:id', validate(taskIdParamSchema), taskController.deleteTask)

export default router