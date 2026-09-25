import { z } from 'zod'
import { objectId } from './common.js'

const optional = (schema) => z.preprocess((v) => (v === '' ? undefined : v), schema.optional())

// Деньги приходят в долларах. Отрицательных не бывает — расход пишется
// отдельной строкой, а не выручкой со знаком минус. Потолок защищает от
// случайно вставленной строки на двадцать цифр.
const money = z.coerce.number().finite().min(0).max(1_000_000_000)

const expenses = z
  .array(z.object({ title: z.string().trim().min(1, 'У расхода должно быть название').max(200), amount: money }))
  .max(30)

/**
 * Режим просмотра. Для «месяца» дата обязательна, иначе непонятно, какой
 * месяц показывать; для «за всё время» никаких дат не нужно вовсе.
 */
export const boardQuery = z
  .object({
    mode: z.enum(['month', 'last', 'all', 'period']).default('month'),
    month: optional(z.coerce.date()),
    // Сколько последних месяцев считать: 3, 6 или 12. Верхняя граница
    // щедрая — вдруг когда-нибудь понадобится «три года».
    months: optional(z.coerce.number().int().min(1).max(60)),
    from: optional(z.coerce.date()),
    to: optional(z.coerce.date()),
  })
  .refine((q) => q.mode !== 'month' || q.month, { message: 'Не выбран месяц', path: ['month'] })
  .refine((q) => q.mode !== 'last' || q.months, { message: 'Не задано число месяцев', path: ['months'] })
  .refine((q) => q.mode !== 'period' || q.from || q.to, { message: 'Не задан период', path: ['from'] })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: 'Начало периода позже конца', path: ['to'] })

export const boardQuerySchema = z.object({ query: boardQuery })

export const boardIdParamSchema = z.object({ params: z.object({ id: objectId }) })

export const cardQuerySchema = z.object({
  params: z.object({ id: objectId }),
  query: boardQuery,
})

export const addClientSchema = z.object({
  body: z
    .object({
      // Либо выбрали существующего клиента, либо вписали название нового.
      clientId: optional(objectId),
      clientName: optional(z.string().trim().min(1).max(200)),
      contact: optional(z.string().trim().max(300)),
      startedAt: optional(z.coerce.date()),
      // Услуги заводятся прямо в форме создания — так описано в задании.
      services: z
        .array(z.object({
          title: z.string().trim().min(1, 'Укажите название услуги').max(200),
          month: z.coerce.date(),
          revenue: money,
          expenses: expenses.optional(),
        }))
        .max(20)
        .optional(),
    })
    .refine((b) => b.clientId || b.clientName, {
      message: 'Выберите клиента или укажите название',
      path: ['clientName'],
    }),
})

export const editClientSchema = z.object({
  params: z.object({ id: objectId }),
  body: z
    .object({
      contact: z.string().trim().max(300).nullable().optional(),
      startedAt: z.coerce.date().optional(),
    })
    .refine((b) => Object.keys(b).length > 0, 'Пустое тело запроса'),
})

export const leaveSchema = z.object({
  params: z.object({ id: objectId }),
  body: z.object({
    // Причина обязательна: ради неё колонка ушедших и заводится.
    reason: z.string().trim().min(1, 'Укажите причину ухода').max(500),
    leftAt: optional(z.coerce.date()),
  }),
})

export const addServiceSchema = z.object({
  body: z.object({
    boardClientId: objectId,
    title: z.string().trim().min(1, 'Укажите название услуги').max(200),
    month: z.coerce.date(),
    revenue: money,
    expenses: expenses.optional(),
  }),
})

export const editServiceSchema = z.object({
  params: z.object({ id: objectId }),
  body: z
    .object({
      title: z.string().trim().min(1).max(200).optional(),
      month: z.coerce.date().optional(),
      revenue: money.optional(),
      expenses: expenses.optional(),
    })
    .refine((b) => Object.keys(b).length > 0, 'Пустое тело запроса'),
})
