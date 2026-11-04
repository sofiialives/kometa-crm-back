import { z } from 'zod'
import { objectId } from './common.js'
import { dayStart, workSpanError } from '../services/boardRules.js'

const optional = (schema) => z.preprocess((v) => (v === '' ? undefined : v), schema.optional())

// Деньги приходят в долларах. Отрицательных не бывает — расход пишется
// отдельной строкой, а не выручкой со знаком минус. Потолок защищает от
// случайно вставленной строки на двадцать цифр.
const money = z.coerce.number().finite().min(0).max(1_000_000_000)

// День начала или конца работ. null сбрасывает срок на весь месяц услуги —
// как и отсутствие значения при создании, поэтому принимаем его везде.
const workDay = optional(z.coerce.date().nullable())

// Границы срока работ между собой. Проверка относительно месяца услуги, когда
// указана только одна граница, живёт в сервисе: здесь месяца может не быть
// (при правке он лежит в базе).
const workSpanCheck = (b) => !b.workFrom || !b.workTo || workSpanError(dayStart(b.workFrom), dayStart(b.workTo)) === null
const workSpanIssue = (b) => ({ message: workSpanError(dayStart(b.workFrom), dayStart(b.workTo)), path: ['workTo'] })

// id и paid нужны при правке услуги: расходы пересоздаются целиком, и по id
// сервер находит прежний расход, чтобы не потерять отметку «выплачено». У новой
// строки id нет (или null). Без paid отметка остаётся как была.
const expenses = z
  .array(z.object({
    id: optional(objectId.nullable()),
    title: z.string().trim().min(1, 'У расхода должно быть название').max(200),
    amount: money,
    paid: z.boolean().optional(),
  }))
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
          paidAt: optional(z.coerce.date()),
          workFrom: workDay,
          workTo: workDay,
          revenue: money,
          expenses: expenses.optional(),
        }).refine(workSpanCheck, workSpanIssue))
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

// Галочка «выплачено» у одного расхода. Только булево значение: строка
// "false" в JavaScript истинна, и такую ошибку лучше отбить на входе.
export const expensePaidSchema = z.object({
  params: z.object({ id: objectId }),
  body: z.object({ paid: z.boolean({ required_error: 'Укажите paid', invalid_type_error: 'paid должно быть true или false' }) }),
})

export const addServiceSchema = z.object({
  body: z
    .object({
      boardClientId: objectId,
      title: z.string().trim().min(1, 'Укажите название услуги').max(200),
      month: z.coerce.date(),
      // День оплаты. В форме обязателен, здесь нет: услуги, заведённые до
      // появления поля, правятся по частям и свою дату получат отдельно.
      paidAt: optional(z.coerce.date()),
      // Срок работ, оба необязательные: пусто — весь месяц услуги.
      workFrom: workDay,
      workTo: workDay,
      revenue: money,
      expenses: expenses.optional(),
    })
    .refine(workSpanCheck, workSpanIssue),
})

export const editServiceSchema = z.object({
  params: z.object({ id: objectId }),
  body: z
    .object({
      title: z.string().trim().min(1).max(200).optional(),
      month: z.coerce.date().optional(),
      paidAt: optional(z.coerce.date()),
      // null сбрасывает границу: работа снова считается с начала или до
      // конца месяца услуги.
      workFrom: workDay,
      workTo: workDay,
      revenue: money.optional(),
      expenses: expenses.optional(),
    })
    .refine((b) => Object.keys(b).length > 0, 'Пустое тело запроса')
    .refine(workSpanCheck, workSpanIssue),
})
