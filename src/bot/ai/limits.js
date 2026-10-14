/**
 * Лимиты ИИ в боте. Посчитаны под бюджет: самый дорогой запрос — около
 * 6 000 единиц текста на входе и 400 на выходе (≈ $0,0008 на Haiku 5.5),
 * 40 запросов на человека в день — не больше $0,99 на человека в месяц.
 * Сверх лимита бот просто работает по своим правилам, как без ИИ.
 */

// Запросов к ИИ на человека в день, по видам.
export const AI_LIMITS = {
  own: 20, // своё сообщение боту
  reply: 10, // ответ на вопрос бота («до скольки?»)
  task: 10, // оценка сложности задачи для «На проверке»
}

// Ответ ИИ — не длиннее этого (ответ человеку в пару предложений).
export const MAX_OUTPUT_TOKENS = 400
// Вход: на русском одна единица текста — не меньше двух символов, так что
// 12 000 символов — не больше 6 000 единиц. Сообщение человека режем до 1 000.
export const MAX_INPUT_CHARS = 12000
export const MAX_MESSAGE_CHARS = 1000

/** Обрезать строку до max символов с многоточием. */
export function cut(text, max) {
  const s = String(text ?? '')
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/**
 * Уложить запрос в лимит: системная часть и сообщение — целиком, потом
 * данные CRM, на что останется места — последние сообщения переписки.
 */
export function fitPrompt({ system, context, history, message }) {
  let room = MAX_INPUT_CHARS - system.length - message.length - 200
  const ctx = cut(context, Math.max(1, Math.min(context.length, room)))
  room -= ctx.length
  const hist = room <= 1 ? '' : history.length > room ? `…${history.slice(-(room - 1))}` : history
  return { system, context: room < 0 ? '' : ctx, history: hist, message }
}
