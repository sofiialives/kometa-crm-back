import { z } from 'zod'
import { objectId } from './common.js'

const optional = (schema) => z.preprocess((v) => (v === '' || v === undefined ? undefined : v), schema.optional())

export const ambassadorLinkSchema = z.object({
  label: z.string().trim().min(1, 'Укажите название соцсети'),
  url: z.string().trim().min(1, 'Укажите ссылку'),
})

export const createAmbassadorSchema = z.object({
  body: z.object({
    theme: z.string().trim().min(1, 'Укажите тематику').max(200),
    conditions: z.string().trim().min(1, 'Укажите условия').max(2000),
    managerComment: optional(z.string().max(2000)),
    callAt: optional(z.coerce.date()),
    telegramGroupLink: z.string().trim().min(1, 'Укажите ссылку на общий чат').max(500),
    contactUsername: z.string().trim().min(2, 'Укажите контакт').regex(/^@/, 'Юзернейм должен начинаться с @').max(100),
    links: z.preprocess((v) => (typeof v === 'string' ? JSON.parse(v) : v), z.array(ambassadorLinkSchema).min(1, 'Добавьте хотя бы одну ссылку на соцсеть')),
  }),
})

const dateOnly = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Неверная дата')

export const listAmbassadorsQuerySchema = z.object({
  query: z.object({
    q: optional(z.string().trim().max(200)),
    theme: optional(z.string().trim().max(200)),
    status: optional(z.enum(['pending', 'approved', 'rejected', 'removed'])),
    fromDate: optional(dateOnly),
    toDate: optional(dateOnly),
  }),
})

export const ambassadorIdParamSchema = z.object({
  params: z.object({ id: objectId }),
})

export const decideAmbassadorSchema = z.object({
  params: z.object({ id: objectId }),
  body: z.object({ decision: z.enum(['approved', 'rejected']) }),
})

export const deleteScreenshotParamSchema = z.object({
  params: z.object({ id: objectId, screenshotId: objectId }),
})
