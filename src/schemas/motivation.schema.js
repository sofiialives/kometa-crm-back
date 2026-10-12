import { z } from 'zod'
import { objectId } from './common.js'
import { isRealDayKey } from '../services/motivation/taskRules.js'

/**
 * Проверка запросов вкладки «Мотивация». Здесь — форма данных: типы,
 * границы, обязательные поля. Права и правила вроде «списать не больше, чем
 * в банке» проверяют сервисы: для этого нужна база.
 */

const optional = (schema) => z.preprocess((v) => (v === '' || v === null ? undefined : v), schema.optional())

// Месяц строкой «ГГГГ-ММ» — без часового пояса, спутать нечего.
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Месяц нужен в виде ГГГГ-ММ')

// Деньги в целых долларах: в задании суммы округляются до доллара, и если
// банк будет с центами, вершина шкалы и итоги начнут расходиться на копейки.
// Потолок защищает от случайно вставленной длинной строки.
const money = z.coerce.number().int('Сумма — целое число долларов').positive('Сумма должна быть больше нуля').max(1_000_000, 'Сумма — не больше 1 000 000 $')
const moneyOrZero = z.coerce.number().int('Сумма — целое число долларов').min(0, 'Сумма не может быть меньше нуля').max(1_000_000, 'Сумма — не больше 1 000 000 $')

// Баллы за одно событие: шкала — сто баллов на месяц.
const points = z.coerce.number().int('Баллы — целое число').min(-100).max(100)

const comment = z.string().trim().max(500)
const requiredComment = z.string().trim().min(1, 'Напишите комментарий').max(500)

const ids = z.array(objectId).min(1, 'Выберите хотя бы одного сотрудника').max(100)

// Ключ формы против повторной отправки: форма придумывает его при открытии
// (crypto.randomUUID). Необязательный — без него операция просто не защищена
// от двойного нажатия.
const requestKey = z.string().uuid('Некорректный ключ запроса')

export const monthQuerySchema = z.object({
  query: z.object({ month: optional(month) }),
})

export const userMonthSchema = z.object({
  params: z.object({ id: objectId }),
  query: z.object({ month: optional(month) }),
})

export const userIdParamSchema = z.object({
  params: z.object({ id: objectId }),
})

export const teamQuerySchema = z.object({
  query: z.object({
    month: optional(month),
    departmentId: optional(objectId),
  }),
})

export const topUpSchema = z.object({
  body: z
    .object({
      userIds: ids,
      amount: money,
      reason: z.enum(['new_client', 'free_budget', 'other']),
      clientId: optional(objectId),
      comment: optional(comment),
      requestKey: optional(requestKey),
    })
    .refine((b) => b.reason !== 'new_client' || b.clientId, {
      message: 'Выберите клиента, за которого пополняется банк',
      path: ['clientId'],
    }),
})

export const writeOffSchema = z.object({
  body: z.object({
    userId: objectId,
    amount: money,
    comment: requiredComment,
    requestKey: optional(requestKey),
  }),
})

export const manualEventSchema = z.object({
  body: z
    .object({
      userId: objectId,
      eventTypeId: optional(objectId),
      prizePoints: optional(points),
      levelPoints: optional(points),
      comment: requiredComment,
      requestKey: optional(requestKey),
    })
    .refine((b) => b.eventTypeId || b.prizePoints !== undefined, {
      message: 'Выберите событие или укажите баллы корректировки',
      path: ['eventTypeId'],
    }),
})

export const productSchema = z.object({
  body: z.object({
    userIds: ids,
    clientId: optional(objectId),
    product: z.string().trim().min(1, 'Укажите продукт').max(200),
    comment: optional(comment),
    requestKey: optional(requestKey),
  }),
})

export const cancelEventSchema = z.object({
  params: z.object({ id: objectId }),
  body: z.object({ reason: requiredComment }),
})

// ---------------------------------------------------------------------------
// Настройки
// ---------------------------------------------------------------------------

const profileTitle = z.string().trim().min(1, 'Укажите название профиля').max(80)

export const createProfileSchema = z.object({
  body: z.object({
    title: profileTitle,
    copyFromId: optional(objectId),
  }),
})

export const updateProfileSchema = z.object({
  params: z.object({ id: objectId }),
  body: z
    .object({
      title: profileTitle.optional(),
      startBank: moneyOrZero.optional(),
      customScale: z.boolean().optional(),
      // Подсказки по номеру уровня работы: { "1": "текст", ... }.
      workHints: z.record(z.string().regex(/^\d{1,2}$/), z.string().max(500)).optional(),
    })
    .refine((b) => Object.keys(b).length > 0, 'Пустое тело запроса'),
})

const autoRule = z.enum(['task_on_time', 'personal_task_on_time', 'task_overdue', 'personal_task_overdue'])

const eventFields = {
  title: z.string().trim().min(1, 'Укажите название события').max(200),
  example: z.string().trim().max(300).nullable(),
  prizePoints: points,
  levelPoints: points,
  mode: z.enum(['manual', 'auto']),
  autoRule: autoRule.nullable(),
  enabled: z.boolean(),
  position: z.coerce.number().int().min(0).max(1000),
}

export const createEventTypeSchema = z.object({
  params: z.object({ id: objectId }),
  body: z.object({
    title: eventFields.title,
    example: eventFields.example.optional(),
    prizePoints: eventFields.prizePoints,
    levelPoints: eventFields.levelPoints.optional(),
    mode: eventFields.mode.optional(),
    autoRule: eventFields.autoRule.optional(),
    enabled: eventFields.enabled.optional(),
  }),
})

export const updateEventTypeSchema = z.object({
  params: z.object({ id: objectId }),
  body: z
    .object({
      title: eventFields.title.optional(),
      example: eventFields.example.optional(),
      prizePoints: eventFields.prizePoints.optional(),
      levelPoints: eventFields.levelPoints.optional(),
      mode: eventFields.mode.optional(),
      autoRule: eventFields.autoRule.optional(),
      enabled: eventFields.enabled.optional(),
      position: eventFields.position.optional(),
    })
    .refine((b) => Object.keys(b).length > 0, 'Пустое тело запроса'),
})

const levels = z
  .array(z.object({
    threshold: z.coerce.number().int('Порог — целое число'),
    percent: z.coerce.number().int('Доля — целое число процентов'),
  }))
  .min(1, 'Нужен хотя бы один уровень')
  .max(10, 'Уровней не может быть больше десяти')

export const globalScaleSchema = z.object({
  body: z.object({ levels }),
})

export const profileScaleSchema = z.object({
  params: z.object({ id: objectId }),
  body: z.object({ levels }),
})

export const workLevelsSchema = z.object({
  body: z.object({
    levels: z
      .array(z.object({
        title: z.string().trim().min(1, 'Укажите название уровня').max(60),
        minPoints: z.coerce.number().int(),
        hint: z.string().trim().max(500).default(''),
        // Каким по счёту этот уровень был до правки. Нужен, чтобы подсказки
        // профилей переехали вместе с уровнем, когда админ вставил новый
        // уровень в середину или убрал один. У нового уровня пусто.
        from: z.coerce.number().int().min(1).max(10).nullable().optional(),
      }))
      .min(1)
      .max(10),
  }),
})

export const generalSettingsSchema = z.object({
  body: z
    .object({
      overduePenaltyCap: z.coerce.number().int().min(0).max(100).optional(),
      personalTaskDailyCap: z.coerce.number().int().min(0).max(100).optional(),
      notifyBank: z.boolean().optional(),
      notifyPoints: z.boolean().optional(),
      autoTasksFrom: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в виде ГГГГ-ММ-ДД')
        .refine(isRealDayKey, 'Такой даты нет')
        .nullable()
        .optional(),
    })
    .refine((b) => Object.keys(b).length > 0, 'Пустое тело запроса'),
})

export const assignmentSchema = z.object({
  params: z.object({ userId: objectId }),
  body: z.object({ profileId: objectId }),
})

// Что сотрудник увидел: время самой свежей записи банка и событий из того
// ответа, который был у него на экране. Не «сейчас»: пополнение, пришедшее,
// пока страница открыта, он ещё не видел.
export const seenSchema = z.object({
  body: z
    .object({
      bankUntil: z.coerce.date().optional(),
      eventsUntil: z.coerce.date().optional(),
    })
    .default({}),
})
