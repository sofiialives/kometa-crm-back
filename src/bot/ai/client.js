import Anthropic from '@anthropic-ai/sdk'
import { env } from '../../config/env.js'
import { modelNow } from './cost.js'
import { MAX_OUTPUT_TOKENS } from './limits.js'
import { recordTokens, takeAiCall } from './usage.js'

/**
 * Связь с Claude. Любая беда — нет ключа, лимит, сеть, отказ модели,
 * обрезанный ответ — даёт null, и бот работает по своим правилам, как без
 * ИИ. Ошибку пишем в лог, человека не грузим.
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
let engineStubbed = false

/** Проверки подменяют и агента (engine.js): тогда ключ не нужен. */
export function markEngineStub(on) {
  engineStubbed = Boolean(on)
}

export function aiEnabled() {
  if (stub || engineStubbed) return true
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

export function noteSuccess() {
  failures = 0
}

/**
 * Разобрать ошибку запроса и включить предохранитель. В лог — только вид
 * ошибки: в тексте сторонней ошибки может оказаться ключ или кусок ответа
 * с данными сотрудника.
 */
export function noteFailure(e) {
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
    keyRejected = true
    console.error('[ИИ] ключ не подходит — ИИ выключен до перезапуска, бот работает по правилам')
  } else if (e instanceof Anthropic.APIError && isOutOfMoney(e)) {
    pausedUntil = Date.now() + OUT_OF_MONEY_PAUSE_MS
    console.error('[ИИ] на ключе закончились деньги или упёрлись в лимит расходов — пауза час, бот работает по шаблонам')
  } else if (e instanceof Anthropic.BadRequestError) {
    // Ошибка в самом запросе — не сбой Anthropic, пауза не поможет.
    console.error(`[ИИ] запрос не принят: ${String(e.message ?? '').slice(0, 200).replace(/sk-ant-\S+/g, '[ключ]')}`)
  } else if (e instanceof Anthropic.APIError) {
    console.error(`[ИИ] ошибка Anthropic ${e.status ?? ''} ${e.constructor.name}`)
    fail()
  } else {
    console.error(`[ИИ] сбой: ${e.name}${e.code ? ` ${e.code}` : ''}`)
    fail()
  }
}

export function getClient() {
  // Без повторов: повтор у нас — это ответ по правилам. Иначе зависший
  // Anthropic держал бы бота для всех.
  client ??= new Anthropic({ apiKey: env.anthropicApiKey, baseURL: 'https://api.anthropic.com', maxRetries: 0, timeout: 60_000 })
  return client
}

// Общий срок на короткий запрос со строгим JSON.
const DEADLINE_MS = 20_000

async function callClaude({ system, user, schema, maxTokens }) {
  const model = env.aiFallbackModel
  const response = await getClient().messages.create({
    model,
    max_tokens: maxTokens,
    // Размышления по необходимости и коротко: задачи здесь простые.
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    system,
    messages: [{ role: 'user', content: user }],
  }, { signal: AbortSignal.timeout(DEADLINE_MS) })
  if (response.stop_reason !== 'end_turn') {
    console.error('[ИИ] ответ не готов:', response.stop_reason)
    return { data: null, usage: response.usage, model }
  }
  const text = response.content.find((b) => b.type === 'text')?.text
  return { data: text ? JSON.parse(text) : null, usage: response.usage, model }
}

/**
 * Короткий запрос со строгим JSON на дешёвой модели: оценка сложности
 * задачи. kind — вид запроса для лимитов, userId — чей лимит.
 * Возвращает разобранный JSON или null.
 */
export async function askJson({ userId, kind, system, user, schema, maxTokens = MAX_OUTPUT_TOKENS }, now = new Date()) {
  if (!aiEnabled()) return null
  try {
    // Деньги на ИИ за день или месяц кончились — и оценки задач ждут.
    if (!stub && !(await modelNow())) return null
    // Лимиты — по настоящему дню, а не по «сейчас» из проверок.
    if (!(await takeAiCall(userId, kind, new Date()))) return null
    if (stub) return await stub({ kind, system, user, schema, now })
    const { data, usage, model } = await callClaude({ system, user, schema, maxTokens })
    await recordTokens(userId, kind, usage, new Date(), model)
    noteSuccess()
    return data
  } catch (e) {
    noteFailure(e)
    return null
  }
}

/** Есть ли ещё запросы у человека сегодня — до того, как собирать данные. */
export { hasAiBudget } from './usage.js'
