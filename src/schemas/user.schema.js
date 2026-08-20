import { z } from 'zod'
import { objectId, emailSchema } from './common.js'

/**
 * Приглашение теперь всегда идёт через отдел: сначала выбирается
 * существующий departmentId (обязателен — без отдела приглашать нельзя),
 * дальше роль, дальше должность. Что именно допустимо в поле position
 * (должна входить в список должностей отдела, кроме lead — там
 * автоматом «Начальник отдела») проверяется в user.service.js, потому
 * что тут нужен доступ к базе, а не только к форме запроса.
 */
export const inviteUserSchema = z.object({
  body: z.object({
    email: emailSchema,
    departmentId: objectId,
    role: z.enum(['admin', 'lead', 'staff']).default('staff'),
    position: z.string().trim().min(1).max(80).optional(),
  }),
})

export const updateUserSchema = z.object({
  params: z.object({ id: objectId }),
  body: z
    .object({
      name: z.string().min(1).optional(),
      position: z.string().min(1).max(80).nullable().optional(),
      role: z.enum(['admin', 'lead', 'staff']).optional(),
      departmentId: objectId.nullable().optional(),
      active: z.boolean().optional(),
    })
    .refine((b) => Object.keys(b).length > 0, 'Пустое тело запроса'),
})

export const userIdParamSchema = z.object({
  params: z.object({ id: objectId }),
})
