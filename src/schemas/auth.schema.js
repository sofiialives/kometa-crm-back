import { z } from 'zod'

export const loginSchema = z.object({
  body: z.object({
    email: z.string().email(),
    password: z.string().min(4),
  }),
})

export const googleLoginSchema = z.object({
  body: z.object({
    idToken: z.string().min(10),
  }),
})

export const refreshSchema = z.object({
  body: z.object({
    refreshToken: z.string().min(10).optional(),
  }),
})
