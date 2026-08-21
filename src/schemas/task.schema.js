import { z } from 'zod'
import { objectId } from './common.js'

export const createTaskSchema = z.object({
  body: z.object({
    title: z.string().trim().min(1),
    description: z.string().trim().max(2000).optional(),
    deadline: z.coerce.date(),
    workId: objectId.nullable().optional(),
    ownerId: objectId.optional(),
  }),
})

export const updateTaskStatusSchema = z.object({
  params: z.object({ id: objectId }),
  body: z.object({
    status: z.enum(['today', 'progress', 'done']),
  }),
})

export const extendTaskDeadlineSchema = z.object({
  params: z.object({ id: objectId }),
  body: z.object({
    deadline: z.coerce.date(),
  }),
})

export const editTaskSchema = z.object({
  params: z.object({ id: objectId }),
  body: z
    .object({
      title: z.string().trim().min(1).optional(),
      description: z.string().trim().max(2000).optional(),
    })
    .refine((b) => Object.keys(b).length > 0, 'Пустое тело запроса'),
})

export const taskIdParamSchema = z.object({
  params: z.object({ id: objectId }),
})

export const listTasksQuerySchema = z.object({
  query: z.object({
    scope: z.enum(['mine', 'department', 'all']).optional(),
    departmentId: objectId.optional(),
  }),
})