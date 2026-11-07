import { z } from 'zod'
import { objectId } from './common.js'

const optional = (schema) => z.preprocess((v) => (v === '' ? undefined : v), schema.optional())

// Деньги приходят в долларах. Отрицательных не бывает — расход пишется
// отдельной строкой, а не выручкой со знаком минус. Потолок — не вкусовщина:
// в базе центы лежат в четырёхбайтовом целом (до 2 147 483 647), то есть
// около 21 474 836 долларов, и сумма больше не поместилась бы в колонку.
const MAX_DOLLARS = 21_000_000
const money = z.coerce
  .number({ invalid_type_error: 'Сумма должна быть числом' })
  .finite('Сумма должна быть числом')
  .min(0, 'Сумма не может быть отрицательной')
  .max(MAX_DOLLARS, 'Сумма не может быть больше 21 000 000')

// Даты доски — от 2000 до 2100 года. Дальше это уже опечатка («0026» вместо
// «2026»), а не срок работ; такая услуга уехала бы в никому не видный месяц.
const MIN_YEAR = 2000
const MAX_YEAR = 2100
const boundedDate = z.coerce
  .date({ errorMap: () => ({ message: 'Некорректная дата' }) })
  .refine(
    (d) => d.getUTCFullYear() >= MIN_YEAR && d.getUTCFullYear() <= MAX_YEAR,
    `Дата должна быть между ${MIN_YEAR} и ${MAX_YEAR} годом`,
  )

// Необязательный день: день выплаты расхода. null значит «не задано», как и
// отсутствие значения.
const optionalDay = optional(boundedDate.nullable())

// Дата выплаты имеет смысл только у выплаченного расхода: «сняли галочку, но
// дата осталась» — противоречие, лучше отказать, чем молча стереть.
const paidAtNeedsPaid = (e) => !e.paidAt || e.paid === true
const paidAtIssue = { message: 'Дата выплаты указывается только вместе с paid: true', path: ['paidAt'] }

// id и paid нужны при правке услуги: расходы пересоздаются целиком, и по id
// сервер находит прежний расход, чтобы не потерять отметку «выплачено». У новой
// строки id нет (или null). Без paid отметка остаётся как была. paidAt — день
// выплаты, который выбрал владелец; не прислали — у выплаченного прежнего
// остаётся прежний, у нового ставится сегодняшний.
const expenses = z
  .array(z.object({
    id: optional(objectId.nullable()),
    title: z.string().trim().min(1, 'У расхода должно быть название').max(200),
    amount: money,
    paid: z.boolean().optional(),
    paidAt: optionalDay,
  }).refine(paidAtNeedsPaid, paidAtIssue))
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
      startedAt: optional(boundedDate),
      // Услуги заводятся прямо в форме создания — так описано в задании.
      services: z
        .array(z.object({
          title: z.string().trim().min(1, 'Укажите название услуги').max(200),
          month: boundedDate,
          paidAt: optional(boundedDate),
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
      startedAt: boundedDate.optional(),
    })
    .refine((b) => Object.keys(b).length > 0, 'Пустое тело запроса'),
})

export const leaveSchema = z.object({
  params: z.object({ id: objectId }),
  body: z.object({
    // Причина обязательна: ради неё колонка ушедших и заводится.
    reason: z.string().trim().min(1, 'Укажите причину ухода').max(500),
    leftAt: optional(boundedDate),
  }),
})

// Галочка «выплачено» у одного расхода. Только булево значение: строка
// "false" в JavaScript истинна, и такую ошибку лучше отбить на входе. paidAt —
// день выплаты, его выбирает владелец; без него ставится сегодняшний.
export const expensePaidSchema = z.object({
  params: z.object({ id: objectId }),
  body: z
    .object({
      paid: z.boolean({ required_error: 'Укажите paid', invalid_type_error: 'paid должно быть true или false' }),
      paidAt: optionalDay,
    })
    .refine(paidAtNeedsPaid, paidAtIssue),
})

export const addServiceSchema = z.object({
  body: z
    .object({
      boardClientId: objectId,
      title: z.string().trim().min(1, 'Укажите название услуги').max(200),
      month: boundedDate,
      // День оплаты. В форме обязателен, здесь нет: услуги, заведённые до
      // появления поля, правятся по частям и свою дату получат отдельно.
      paidAt: optional(boundedDate),
      revenue: money,
      expenses: expenses.optional(),
    }),
})

export const editServiceSchema = z.object({
  params: z.object({ id: objectId }),
  body: z
    .object({
      title: z.string().trim().min(1).max(200).optional(),
      month: boundedDate.optional(),
      paidAt: optional(boundedDate),
      revenue: money.optional(),
      expenses: expenses.optional(),
    })
    .refine((b) => Object.keys(b).length > 0, 'Пустое тело запроса'),
})
