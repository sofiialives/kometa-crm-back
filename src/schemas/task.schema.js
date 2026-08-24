import { z } from 'zod'
import { objectId } from './common.js'

const priorityEnum = z.enum(['low', 'medium', 'high'])

export const createTaskSchema = z.object({
  body: z.object({
    title: z.string().trim().min(1),
    description: z.string().trim().max(2000).optional(),
    deadline: z.coerce.date(),
    workId: objectId.nullable().optional(),
    // Несколько человек на одну задачу — только для Иерархии (lead/admin).
    // Если не передан вообще — задача автору, как и раньше.
    ownerIds: z.array(objectId).min(1).max(20).optional(),
    priority: priorityEnum.optional(),
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
      priority: priorityEnum.optional(),
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
    // Личная доска «Задачи» просит ?standalone=true — задачи, привязанные
    // к работе из Иерархии, туда не должны попадать вообще никогда.
    standalone: z.enum(['true', 'false']).optional(),
  }),
})
