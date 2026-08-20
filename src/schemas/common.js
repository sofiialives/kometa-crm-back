import { z } from 'zod'

/**
 * Раньше ждали 24-символьный hex как в MongoDB ObjectId.
 * Prisma с провайдером Postgres по умолчанию генерирует cuid
 * (например cmt1ik0w80001ijqro3uumtss) — под старый паттерн не попадал,
 * из-за этого /users/:id/deactivate падал с "Некорректный id".
 * Проверяем мягче: непустая строка из букв/цифр/дефисов/подчёркиваний.
 */
export const objectId = z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/, 'Некорректный id')

/**
 * zod .email() в версии 3.25 отбраковывает нестандартные TLD вроде .web3
 * (kometa.web3), хотя формат почты валиден. Используем свой мягкий regex
 * вместо строгого встроенного чекера.
 */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Некорректный email')
