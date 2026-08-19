import { z } from 'zod'
import { objectId } from './common.js'

export const createDepartmentSchema = z.object({
  body: z.object({
    name: z.string().min(2),
    leadId: objectId.nullable().optional(),
  }),
})

export const updateDepartmentSchema = z.object({
  params: z.object({ id: objectId }),
  body: z.object({
    name: z.string().min(2).optional(),
    leadId: objectId.nullable().optional(),
  }),
})
