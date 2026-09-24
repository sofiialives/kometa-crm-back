import { S3Client, DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { env } from '../config/env.js'
import { ApiError } from './ApiError.js'

/**
 * Объектное хранилище для файлов Архива — Cloudflare R2.
 *
 * Почему не диск сервера: на Render файловая система стирается при каждом
 * деплое, а постоянный диск не даёт поднимать новую версию до остановки
 * старой. Архив должен переживать и то, и другое.
 *
 * Почему AWS SDK, а не библиотека Cloudflare: R2 совместим с S3, и обычный
 * клиент работает с ним как есть. Заодно это означает, что переехать на
 * любое другое S3-совместимое хранилище можно сменой четырёх переменных
 * окружения, не трогая код.
 */

export const storageReady = () =>
  Boolean(env.r2.accountId && env.r2.accessKeyId && env.r2.secretAccessKey && env.r2.bucket)

let client = null

// Клиент создаётся при первом обращении, а не при импорте: без ключей
// сервер должен запускаться как обычно, иначе разработка требовала бы
// заводить аккаунт хранилища.
function s3() {
  if (!storageReady()) {
    throw ApiError.badRequest(
      'Хранилище файлов не настроено — задайте R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY и R2_BUCKET',
    )
  }
  if (!client) {
    client = new S3Client({
      // У R2 один общий регион, поэтому 'auto'.
      region: 'auto',
      endpoint: `https://${env.r2.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: env.r2.accessKeyId,
        secretAccessKey: env.r2.secretAccessKey,
      },
    })
  }
  return client
}

export async function putObject(key, body, contentType) {
  await s3().send(new PutObjectCommand({
    Bucket: env.r2.bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
  }))
}

/**
 * Возвращает поток файла. Файл идёт через наш сервер, а не по прямой
 * ссылке из хранилища, — только так можно проверить отдел перед выдачей.
 * Прямой ссылки на чужой отчёт попросту не существует.
 */
export async function getObjectStream(key) {
  const res = await s3().send(new GetObjectCommand({ Bucket: env.r2.bucket, Key: key }))
  return res.Body
}

/**
 * Удаление не бросает: файл мог уже исчезнуть, и это не повод ронять
 * запрос, который в остальном отработал.
 */
export async function deleteObject(key) {
  try {
    await s3().send(new DeleteObjectCommand({ Bucket: env.r2.bucket, Key: key }))
  } catch (e) {
    console.error(`[архив] файл ${key} не удалён из хранилища:`, e.message)
  }
}
