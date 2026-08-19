import { z } from 'zod'
import { objectId } from './common.js'

export const createUserSchema = z.object({
  body: z.object({
    name: z.string().min(2),
    email: z.string().email(),
    password: z.string().min(4),
    role: z.enum(['admin', 'lead', 'staff']).default('staff'),
    departmentId: objectId.nullable().optional(),
  }),
})

export const updateUserSchema = z.object({
  params: z.object({ id: objectId }),
  body: z
    .object({
      name: z.string().min(2).optional(),
      role: z.enum(['admin', 'lead', 'staff']).optional(),
      departmentId: objectId.nullable().optional(),
      active: z.boolean().optional(),
    })
    .refine((b) => Object.keys(b).length > 0, 'Пустое тело запроса'),
})

export const userIdParamSchema = z.object({
  params: z.object({ id: objectId }),
})
