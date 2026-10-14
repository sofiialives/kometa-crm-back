import Anthropic from '@anthropic-ai/sdk'
import { env } from '../../config/env.js'
import { MAX_OUTPUT_TOKENS } from './limits.js'
import { recordTokens, takeAiCall } from './usage.js'

/**
 * Запрос к Claude со строгим JSON на выходе. Любая беда — нет ключа, лимит,
 * сеть, отказ модели, обрезанный ответ — даёт null, и бот работает по
 * своим правилам, как без ИИ. Ошибку пишем в лог, человека не грузим.
 */

let client = null
let stub = null

/** Подмена ИИ в проверках: fn({ kind, system, user, schema }) → объект или null. */
export function setAiStub(fn) {
  stub = fn
}

export function aiEnabled() {
  return Boolean(stub || env.anthropicApiKey)
}

function getClient() {
  // Один повтор и 20 секунд: человек в телеграме дольше не ждёт.
  client ??= new Anthropic({ apiKey: env.anthropicApiKey, maxRetries: 1, timeout: 20_000 })
  return client
}

async function callClaude({ system, user, schema }) {
  const response = await getClient().messages.create({
    model: env.aiModel,
    max_tokens: MAX_OUTPUT_TOKENS,
    // Без размышлений: они тоже идут в счёт ответа, а задачи здесь простые.
    thinking: { type: 'disabled' },
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    system,
    messages: [{ role: 'user', content: user }],
  })
  if (response.stop_reason !== 'end_turn') {
    console.error('[ИИ] ответ не готов:', response.stop_reason)
    return { data: null, usage: response.usage }
  }
  const text = response.content.find((b) => b.type === 'text')?.text
  return { data: text ? JSON.parse(text) : null, usage: response.usage }
}

/**
 * kind — вид запроса для лимитов (own, reply, task), userId — чей лимит.
 * Возвращает разобранный JSON или null.
 */
export async function askJson({ userId, kind, system, user, schema }, now = new Date()) {
  if (!aiEnabled()) return null
  // Лимиты — по настоящему дню, а не по «сейчас» из проверок.
  if (!(await takeAiCall(userId, kind, new Date()))) return null
  try {
    if (stub) return await stub({ kind, system, user, schema, now })
    const { data, usage } = await callClaude({ system, user, schema })
    await recordTokens(userId, kind, usage, new Date())
    return data
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) console.error('[ИИ] ключ не подходит')
    else if (e instanceof Anthropic.RateLimitError) console.error('[ИИ] лимит запросов Anthropic')
    else if (e instanceof Anthropic.APIError) console.error(`[ИИ] ошибка ${e.status}:`, e.message)
    else console.error('[ИИ]', e.message)
    return null
  }
}
