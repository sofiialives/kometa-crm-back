import crypto from 'crypto'
import { prisma } from '../config/prisma.js'
import { env } from '../config/env.js'
import { ApiError } from '../utils/ApiError.js'

// Коду достаточно жить считанные минуты: человек жмёт кнопку и тут же
// открывает бота. Чем короче окно, тем меньше шансов, что ссылка
// куда-то утечёт и ею воспользуется не тот.
const CODE_TTL_MIN = 15

export async function getStatus(userId) {
  const link = await prisma.telegramLink.findUnique({ where: { userId } })
  return {
    linked: Boolean(link?.chatId),
    username: link?.username || null,
    linkedAt: link?.linkedAt || null,
    botUsername: env.telegramBotUsername || null,
  }
}

/**
 * Выдаёт одноразовый код и ссылку на бота.
 *
 * Код случайный и длинный: он и есть доказательство, что человек вошёл
 * в CRM под собой. Угадать его нельзя, а живёт он минуты.
 */
export async function issueCode(userId) {
  if (!env.telegramBotUsername) {
    throw ApiError.badRequest('Бот напоминаний ещё не настроен — не задан TELEGRAM_BOT_USERNAME')
  }

  const code = crypto.randomBytes(24).toString('base64url')
  const codeExpiresAt = new Date(Date.now() + CODE_TTL_MIN * 60 * 1000)

  await prisma.telegramLink.upsert({
    where: { userId },
    create: { userId, code, codeExpiresAt },
    update: { code, codeExpiresAt },
  })

  return {
    deepLink: `https://t.me/${env.telegramBotUsername}?start=${code}`,
    expiresInMin: CODE_TTL_MIN,
  }
}

export async function unlink(userId) {
  await prisma.telegramLink.deleteMany({ where: { userId } })
}
