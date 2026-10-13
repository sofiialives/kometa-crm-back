/**
 * Чего бот ждёт от человека прямо сейчас: «до скольки задерживаешься?»,
 * «что случилось?». Живёт в памяти и гаснет через 15 минут — после
 * перезапуска человек просто напишет ещё раз, а бот поймёт по словам.
 */

const TTL_MS = 15 * 60 * 1000
const waiting = new Map()

export function expect(userId, type, payload = {}) {
  waiting.set(userId, { type, payload, until: Date.now() + TTL_MS })
}

export function take(userId) {
  const item = waiting.get(userId)
  waiting.delete(userId)
  return item && item.until > Date.now() ? item : null
}

export function clear(userId) {
  waiting.delete(userId)
}
