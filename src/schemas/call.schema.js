import { z } from 'zod'
import { objectId } from './common.js'

export const listCallsQuerySchema = z.object({
  query: z.object({
    // scope=all — вкладка «Все звонки», доступна только админу.
    // Без параметра каждый получает свою видимость: сотрудник — свои
    // звонки, главный отдела — звонки всего отдела.
    scope: z.enum(['mine', 'all']).optional(),
  }),
})

// Ограничения по дате намеренно нет: звонок в прошлом сразу получит
// пометку «прошёл» и уйдёт ближайшей ночью — ломать этим нечего, а
// лишняя проверка мешала бы, например, записать звонок задним числом.
export const createCallSchema = z.object({
  body: z.object({
    title: z.string().trim().min(1),
    note: z.string().trim().max(2000).optional(),
    scheduledAt: z.coerce.date(),
  }),
})

export const editCallSchema = z.object({
  params: z.object({ id: objectId }),
  body: z
    .object({
      title: z.string().trim().min(1).optional(),
      note: z.string().trim().max(2000).optional(),
      scheduledAt: z.coerce.date().optional(),
    })
    .refine((b) => Object.keys(b).length > 0, 'Пустое тело запроса'),
})

export const callIdParamSchema = z.object({
  params: z.object({ id: objectId }),
})
