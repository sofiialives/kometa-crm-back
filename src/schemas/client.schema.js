import { z } from 'zod'
import { objectId } from './common.js'

export const createClientSchema = z.object({
  body: z.object({
    name: z.string().trim().min(1).max(120),
  }),
})

export const updateClientSchema = z.object({
  params: z.object({ id: objectId }),
  body: z.object({
    name: z.string().trim().min(1).max(120),
  }),
})

export const clientIdParamSchema = z.object({
  params: z.object({ id: objectId }),
})
