import { z } from 'zod'
import { objectId } from './common.js'

// Фронт шлёт незаполненные фильтры пустой строкой, а не пропускает их.
// Без этого пустой фильтр приехал бы в запрос как настоящее значение.
const optional = (schema) => z.preprocess((v) => (v === '' ? undefined : v), schema.optional())

export const listArchiveClientsSchema = z.object({
  query: z.object({
    departmentId: optional(objectId),
    q: optional(z.string().trim().max(200)),
  }),
})

export const archiveIdParamSchema = z.object({
  params: z.object({ id: objectId }),
})

export const addArchiveClientSchema = z.object({
  body: z.object({ clientId: objectId }),
})

export const createServiceSchema = z.object({
  body: z.object({
    archiveClientId: objectId,
    departmentId: objectId,
    // Название пишут руками каждый раз — так решил заказчик, зная, что
    // «Таргет» и «таргетинг» станут разными строками в фильтре.
    title: z.string().trim().min(1, 'Название услуги обязательно').max(200),
  }),
})

export const editServiceSchema = z.object({
  params: z.object({ id: objectId }),
  body: z.object({ title: z.string().trim().min(1, 'Название услуги обязательно').max(200) }),
})

export const listReportsQuerySchema = z.object({
  query: z.object({
    departmentId: optional(objectId),
    clientId: optional(objectId),
    serviceId: optional(objectId),
    authorId: optional(objectId),
    from: optional(z.coerce.date()),
    to: optional(z.coerce.date()),
    q: optional(z.string().trim().max(200)),
    // Архив, в отличие от задач и звонков, не чистится по ночам и растёт
    // вечно — поэтому постранично с первого дня, а не «когда затормозит».
    limit: z.coerce.number().int().min(1).max(100).default(30),
    offset: z.coerce.number().int().min(0).default(0),
  }),
})

export const listReportAuthorsSchema = z.object({
  query: z.object({ departmentId: optional(objectId) }),
})

export const uploadReportSchema = z.object({
  body: z.object({
    serviceId: objectId,
    // Необязательная: подставится сегодняшний день. Нужна потому, что архив
    // наполняют старыми отчётами, и без неё все они получили бы дату
    // загрузки, а фильтр по периоду стал бы бесполезен.
    workedAt: optional(z.coerce.date()),
  }),
})
