import Anthropic from '@anthropic-ai/sdk'
import { env } from '../../config/env.js'
import { MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS_OWNER } from './limits.js'
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

// Предохранитель: ключ не подошёл — ИИ выключен до перезапуска; три сбоя
// подряд (сеть, Anthropic лежит) — пауза 10 минут. Бот всё это время
// работает по правилам и не тратит на ИИ ни время, ни лимиты.
let keyRejected = false
let failures = 0
let pausedUntil = 0

export function aiEnabled() {
  if (stub) return true
  return Boolean(env.anthropicApiKey) && !keyRejected && Date.now() >= pausedUntil
}

// Кончились деньги на ключе или упёрлись в лимит расходов в консоли — это
// не сбой на минуту: час не стучимся, бот отвечает шаблонами. Сам текст
// ошибки в лог не пишем.
const OUT_OF_MONEY_PAUSE_MS = 60 * 60000
export function isOutOfMoney(e) {
  return e?.status === 400 && /credit balance|billing|usage limits?|spend(ing)? limit/i.test(String(e?.message ?? ''))
}

function fail() {
  failures += 1
  if (failures >= 3) {
    pausedUntil = Date.now() + 10 * 60000
    // После паузы — одна проба: снова сбой — снова пауза.
    failures = 2
    console.error('[ИИ] сбои подряд — пауза 10 минут, бот работает по правилам')
  }
}

function getClient() {
  // Без повторов: повтор у нас — это ответ по правилам. Иначе зависший
  // Anthropic держал бы бота для всех.
  client ??= new Anthropic({ apiKey: env.anthropicApiKey, baseURL: 'https://api.anthropic.com', maxRetries: 0, timeout: 10_000 })
  return client
}

// Общий срок на запрос, включая ожидание по Retry-After.
const DEADLINE_MS = 10_000

async function callClaude({ system, user, schema, maxTokens }) {
  const response = await getClient().messages.create({
    model: env.aiModel,
    max_tokens: maxTokens,
    // Без размышлений: они тоже идут в счёт ответа, а задачи здесь простые.
    thinking: { type: 'disabled' },
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    system,
    messages: [{ role: 'user', content: user }],
  }, { signal: AbortSignal.timeout(DEADLINE_MS) })
  if (response.stop_reason !== 'end_turn') {
    console.error('[ИИ] ответ не готов:', response.stop_reason)
    return { data: null, usage: response.usage }
  }
  const text = response.content.find((b) => b.type === 'text')?.text
  return { data: text ? JSON.parse(text) : null, usage: response.usage }
}

/**
 * kind — вид запроса для лимитов (own, reply, task), userId — чей лимит.
 * maxTokens — потолок ответа, не больше MAX_OUTPUT_TOKENS_OWNER.
 * Возвращает разобранный JSON или null.
 */
export async function askJson({ userId, kind, system, user, schema, maxTokens = MAX_OUTPUT_TOKENS }, now = new Date()) {
  if (!aiEnabled()) return null
  try {
    // Лимиты — по настоящему дню, а не по «сейчас» из проверок.
    if (!(await takeAiCall(userId, kind, new Date()))) return null
    if (stub) return await stub({ kind, system, user, schema, now })
    const { data, usage } = await callClaude({ system, user, schema, maxTokens: Math.min(maxTokens, MAX_OUTPUT_TOKENS_OWNER) })
    await recordTokens(userId, kind, usage, new Date())
    failures = 0
    return data
  } catch (e) {
    // В лог — только вид ошибки: в тексте сторонней ошибки может оказаться
    // ключ или кусок ответа с данными сотрудника.
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
      keyRejected = true
      console.error('[ИИ] ключ не подходит — ИИ выключен до перезапуска, бот работает по правилам')
    } else if (e instanceof Anthropic.APIError && isOutOfMoney(e)) {
      pausedUntil = Date.now() + OUT_OF_MONEY_PAUSE_MS
      console.error('[ИИ] на ключе закончились деньги или упёрлись в лимит расходов — пауза час, бот работает по шаблонам')
    } else if (e instanceof Anthropic.APIError) {
      console.error(`[ИИ] ошибка Anthropic ${e.status ?? ''} ${e.constructor.name}`)
      fail()
    } else {
      console.error(`[ИИ] сбой: ${e.name}${e.code ? ` ${e.code}` : ''}`)
      fail()
    }
    return null
  }
}

/** Есть ли ещё запросы у человека сегодня — до того, как собирать данные. */
export { hasAiBudget } from './usage.js'
