import { Prisma } from '@prisma/client'
import jwt from 'jsonwebtoken'
import { ApiError } from './ApiError.js'

export function normalizeError(err) {
  if (err instanceof ApiError) return err

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    return fromPrismaKnownError(err)
  }

  if (err instanceof Prisma.PrismaClientValidationError) {
    return ApiError.badRequest('Некорректные данные для запроса к базе')
  }

  if (err instanceof Prisma.PrismaClientInitializationError) {
    return new ApiError(503, 'Нет соединения с базой данных. Проверьте DATABASE_URL и что Postgres запущен')
  }

  if (err instanceof jwt.TokenExpiredError) {
    return ApiError.unauthorized('Сессия истекла, войдите заново')
  }
  if (err instanceof jwt.JsonWebTokenError) {
    return ApiError.unauthorized('Токен недействителен')
  }

  return err
}

const PRISMA_CODE_MESSAGES = {
  P2002: 'Запись с такими данными уже существует',
  P2003: 'Связанная запись не найдена (проверьте отдел/пользователя)',
  P2025: 'Запись не найдена',
  P2021: 'Таблицы в базе ещё нет. Выполните: npx prisma migrate dev',
  P2022: 'В базе не хватает колонки. Выполните: npx prisma migrate dev',
}

function fromPrismaKnownError(err) {
  const message = PRISMA_CODE_MESSAGES[err.code] || `Ошибка базы данных (${err.code})`
  const status = err.code === 'P2025' ? 404 : err.code === 'P2002' ? 409 : 400
  return new ApiError(status, message, { prismaCode: err.code })
}