import { prisma } from '../../config/prisma.js'
import { env } from '../../config/env.js'
import { mskDayKey } from '../plan.js'

/**
 * Деньги на ИИ. Цены — со страницы цен Anthropic, в долларах за миллион
 * единиц текста: вход, выход, запись в кэш на 5 минут, чтение из кэша.
 * Haiku 5.5 — по тарифу для запросов до 100 тысяч, наши намного короче.
 */
export const PRICES = {
  'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
}

// Незнакомая модель считается по самой дорогой цене: лучше бюджет кончится
// раньше, чем деньги на ключе.
const priceOf = (model) => PRICES[model] ?? PRICES['claude-sonnet-5-5']

/** Во что обошёлся ответ, в миллионных долях доллара. */
export function costMicros(usage, model) {
  if (!usage) return 0
  const p = priceOf(model)
  return Math.ceil(
    (usage.input_tokens ?? 0) * p.input
    + (usage.output_tokens ?? 0) * p.output
    + (usage.cache_creation_input_tokens ?? 0) * p.cacheWrite
    + (usage.cache_read_input_tokens ?? 0) * p.cacheRead,
  )
}

export const micros = (usd) => Math.round(usd * 1_000_000)

// Один человек не выбирает дневной бюджет за всех: у сотрудника и
// руководителя свой потолок в день. И последние полдоллара дня на основной
// модели — только Яну: агент у него должен работать, даже если команда
// весь день гоняла бота.
export const USER_DAILY_USD = { staff: 0.5, lead: 1 }
export const OWNER_RESERVE_USD = 0.5

/**
 * Какой моделью отвечать по потраченному. Основная — пока день не вышел за
 * дневной бюджет (у команды — без запаса Яна); потом запасная, ещё немного
 * сверху; свой потолок человека или месяц исчерпаны — null, бот работает
 * по правилам. why — почему null: user, day или month.
 */
export function pickModel({ dayMicros, monthMicros, userMicros = 0 }, role = 'admin') {
  if (monthMicros >= micros(env.aiMonthlyUsd)) return { model: null, why: 'month' }
  const own = USER_DAILY_USD[role]
  if (own !== undefined && userMicros >= micros(own)) return { model: null, why: 'user' }
  const reserve = role === 'admin' ? 0 : OWNER_RESERVE_USD
  if (dayMicros < micros(env.aiDailyUsd - reserve)) return { model: env.aiModel }
  if (dayMicros < micros(env.aiDailyUsd + env.aiFallbackDailyUsd)) return { model: env.aiFallbackModel }
  return { model: null, why: 'day' }
}

/** Сколько потрачено сегодня, за месяц и сегодня этим человеком (по Москве). */
export async function spent(now = new Date(), userId = null) {
  const day = mskDayKey(now)
  const [today, month, mine] = await Promise.all([
    prisma.aiUsage.aggregate({ where: { day }, _sum: { costMicros: true } }),
    prisma.aiUsage.aggregate({ where: { day: { startsWith: day.slice(0, 7) } }, _sum: { costMicros: true } }),
    userId ? prisma.aiUsage.aggregate({ where: { day, userId }, _sum: { costMicros: true } }) : null,
  ])
  return { dayMicros: today._sum.costMicros ?? 0, monthMicros: month._sum.costMicros ?? 0, userMicros: mine?._sum.costMicros ?? 0 }
}

/** Модель для ответа человеку сейчас: { model } или { model: null, why }. */
export async function modelFor({ userId = null, role = 'admin' } = {}, now = new Date()) {
  return pickModel(await spent(now, userId), role)
}

/** Модель сейчас без учёта человека — для коротких служебных запросов. */
export async function modelNow(now = new Date()) {
  return (await modelFor({}, now)).model
}
