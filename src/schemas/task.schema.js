import { z } from 'zod'
import { objectId } from './common.js'

export const createTaskSchema = z.object({
  body: z.object({
    title: z.string().trim().min(1),
    description: z.string().trim().max(2000).optional(),
    deadline: z.coerce.date(),
    workId: objectId.nullable().optional(),
  }),
})

export const updateTaskStatusSchema = z.object({
  params: z.object({ id: objectId }),
  body: z.object({
    status: z.enum(['today', 'progress', 'done']),
  }),
})

export const listTasksQuerySchema = z.object({
  query: z.object({
    scope: z.enum(['mine', 'department', 'all']).optional(),
    departmentId: objectId.optional(),
  }),
})