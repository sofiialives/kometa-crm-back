import { prisma } from '../../config/prisma.js'
import { env } from '../../config/env.js'
import { mskDayKey } from '../plan.js'
import { aiLimit } from './limits.js'
import { costMicros } from './cost.js'

/**
 * Учёт запросов к ИИ: лимит на человека в день по видам и общий дневной
 * потолок на всех. Запрос сначала «занимает» место — два одновременных
 * сообщения не проскочат сверх лимита.
 */

/** Можно ли сделать запрос; если да — он сразу засчитан. */
export async function takeAiCall(userId, kind, now = new Date(), role = null) {
  const limit = aiLimit(kind, role)
  if (!limit || !userId) return false
  const day = mskDayKey(now)
  return prisma.$transaction(async (tx) => {
    // Один замок на все запросы к ИИ: общий потолок считается без гонок.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('ai-usage'))`
    const total = await tx.aiUsage.aggregate({ where: { day }, _sum: { calls: true, inputTokens: true, outputTokens: true } })
    if ((total._sum.calls ?? 0) >= env.aiDailyCap) return false
    if ((total._sum.inputTokens ?? 0) + (total._sum.outputTokens ?? 0) >= env.aiDailyTokens) return false
    const row = await tx.aiUsage.findUnique({ where: { userId_day_kind: { userId, day, kind } } })
    if ((row?.calls ?? 0) >= limit) return false
    await tx.aiUsage.upsert({
      where: { userId_day_kind: { userId, day, kind } },
      create: { userId, day, kind, calls: 1 },
      update: { calls: { increment: 1 } },
    })
    return true
  })
}

/**
 * Остались ли у человека запросы сегодня — без записи. Чтобы не собирать
 * данные из CRM зря, когда лимит уже выбран.
 */
export async function hasAiBudget(userId, kind, now = new Date(), role = null) {
  const limit = aiLimit(kind, role)
  if (!limit || !userId) return false
  const day = mskDayKey(now)
  const [row, total] = await Promise.all([
    prisma.aiUsage.findUnique({ where: { userId_day_kind: { userId, day, kind } }, select: { calls: true } }),
    prisma.aiUsage.aggregate({ where: { day }, _sum: { calls: true, inputTokens: true, outputTokens: true } }),
  ])
  return (row?.calls ?? 0) < limit
    && (total._sum.calls ?? 0) < env.aiDailyCap
    && (total._sum.inputTokens ?? 0) + (total._sum.outputTokens ?? 0) < env.aiDailyTokens
}

/** Сколько текста ушло и пришло и во что обошлось — для бюджета и отчёта. */
export async function recordTokens(userId, kind, usage, now = new Date(), model = null) {
  if (!usage) return
  const day = mskDayKey(now)
  await prisma.aiUsage.upsert({
    where: { userId_day_kind: { userId, day, kind } },
    create: {
      userId, day, kind, calls: 0,
      inputTokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
      outputTokens: usage.output_tokens ?? 0,
      costMicros: costMicros(usage, model),
    },
    update: {
      inputTokens: { increment: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) },
      outputTokens: { increment: usage.output_tokens ?? 0 },
      costMicros: { increment: costMicros(usage, model) },
    },
  }).catch((e) => console.error('[ИИ] учёт:', e.message))
}
