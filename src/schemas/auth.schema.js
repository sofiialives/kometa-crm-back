import { z } from 'zod'
import { emailSchema } from './common.js'

export const loginSchema = z.object({
  body: z.object({
    email: emailSchema,
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

export const forgotPasswordSchema = z.object({
  body: z.object({
    email: emailSchema,
  }),
})

export const resetPasswordSchema = z.object({
  body: z.object({
    email: emailSchema,
    code: z.string().length(6),
    newPassword: z.string().min(4),
  }),
})

export const updateMeSchema = z.object({
  body: z
    .object({
      name: z.string().trim().min(1).max(80).optional(),
      avatarUrl: z.string().max(2_000_000).nullable().optional(),
      avatarColor: z.string().trim().max(20).nullable().optional(),
    })
    .refine((b) => Object.keys(b).length > 0, 'Пустое тело запроса'),
})

export const changePasswordSchema = z.object({
  body: z.object({
    currentPassword: z.string().optional(),
    newPassword: z.string().min(4),
  }),
})
