import { z } from 'zod'
import { objectId } from './common.js'

export const createWorkSchema = z.object({
  body: z.object({
    clientName: z.string().min(1),
    title: z.string().min(1),
    departmentId: objectId,
    assignees: z.array(objectId).default([]),
  }),
})

export const updateWorkSchema = z.object({
  params: z.object({ id: objectId }),
  body: z.object({
    title: z.string().min(1).optional(),
    assignees: z.array(objectId).optional(),
    status: z.enum(['active', 'done', 'archived']).optional(),
  }),
})

export const workIdParamSchema = z.object({
  params: z.object({ id: objectId }),
})

export const deleteClientSchema = z.object({
  params: z.object({ clientName: z.string().min(1) }),
})
