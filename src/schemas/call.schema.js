import { z } from 'zod'
import { objectId } from './common.js'

export const listCallsQuerySchema = z.object({
  query: z.object({
    // scope=all — вкладка «Все звонки», доступна только админу.
    // Без параметра каждый получает свою видимость: сотрудник — свои
    // звонки, главный отдела — звонки всего отдела.
    scope: z.enum(['mine', 'all']).optional(),
    // Вкладка конкретного отдела у админа. Звонок попадает в неё, если в
    // нём есть человек из этого отдела — организатор или участник.
    departmentId: objectId.optional(),
  }),
})

// Ограничения по дате намеренно нет: звонок в прошлом сразу получит
// пометку «прошёл» и уйдёт ближайшей ночью — ломать этим нечего, а
// лишняя проверка мешала бы, например, записать звонок задним числом.
export const createCallSchema = z.object({
  body: z.object({
    title: z.string().trim().min(1),
    // Заметка обязательна: без контекста карточка «Ozon, 15:00» через
    // день ничего не говорит ни автору, ни участникам звонка.
    note: z.string().trim().min(1, 'Заметка обязательна').max(2000),
    scheduledAt: z.coerce.date(),
    // Кого позвали. Организатора сюда писать не нужно — он и так в звонке.
    participantIds: z.array(objectId).max(20).optional(),
  }),
})

export const editCallSchema = z.object({
  params: z.object({ id: objectId }),
  body: z
    .object({
      title: z.string().trim().min(1).optional(),
      note: z.string().trim().min(1, 'Заметка обязательна').max(2000).optional(),
      scheduledAt: z.coerce.date().optional(),
      participantIds: z.array(objectId).max(20).optional(),
    })
    .refine((b) => Object.keys(b).length > 0, 'Пустое тело запроса'),
})

export const callIdParamSchema = z.object({
  params: z.object({ id: objectId }),
})
