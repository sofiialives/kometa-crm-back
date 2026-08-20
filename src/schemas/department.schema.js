import { z } from 'zod'
import { objectId } from './common.js'

const positionsArray = z.array(z.string().trim().min(1).max(80))

export const createDepartmentSchema = z.object({
  body: z.object({
    name: z.string().min(2),
    leadId: objectId.nullable().optional(),
    positions: positionsArray.default([]),
  }),
})

export const updateDepartmentSchema = z.object({
  params: z.object({ id: objectId }),
  body: z.object({
    name: z.string().min(2).optional(),
    leadId: objectId.nullable().optional(),
    positions: positionsArray.optional(),
  }),
})
