import { Router } from 'express'
import { validate } from '../middlewares/validate.middleware.js'
import { authenticate, authorize } from '../middlewares/auth.middleware.js'
import { createDepartmentSchema, updateDepartmentSchema, departmentIdParamSchema } from '../schemas/department.schema.js'
import * as departmentController from '../controllers/department.controller.js'

const router = Router()

router.use(authenticate)

router.get('/', departmentController.listDepartments)
router.post('/', authorize('admin'), validate(createDepartmentSchema), departmentController.createDepartment)
router.patch('/:id', authorize('admin'), validate(updateDepartmentSchema), departmentController.updateDepartment)
router.delete('/:id', authorize('admin'), validate(departmentIdParamSchema), departmentController.deleteDepartment)

export default router