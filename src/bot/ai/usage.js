import { prisma } from '../../config/prisma.js'
import { env } from '../../config/env.js'
import { mskDayKey } from '../plan.js'
import { AI_LIMITS } from './limits.js'

/**
 * Учёт запросов к ИИ: лимит на человека в день по видам и общий дневной
 * потолок на всех. Запрос сначала «занимает» место — два одновременных
 * сообщения не проскочат сверх лимита.
 */

/** Можно ли сделать запрос; если да — он сразу засчитан. */
export async function takeAiCall(userId, kind, now = new Date()) {
  const limit = AI_LIMITS[kind]
  if (!limit || !userId) return false
  const day = mskDayKey(now)
  return prisma.$transaction(async (tx) => {
    // Один замок на все запросы к ИИ: общий потолок считается без гонок.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('ai-usage'))`
    const total = await tx.aiUsage.aggregate({ where: { day }, _sum: { calls: true } })
    if ((total._sum.calls ?? 0) >= env.aiDailyCap) return false
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

/** Сколько текста ушло и пришло — для отчёта о расходах. */
export async function recordTokens(userId, kind, usage, now = new Date()) {
  if (!usage) return
  const day = mskDayKey(now)
  await prisma.aiUsage.update({
    where: { userId_day_kind: { userId, day, kind } },
    data: {
      inputTokens: { increment: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) },
      outputTokens: { increment: usage.output_tokens ?? 0 },
    },
  }).catch((e) => console.error('[ИИ] учёт:', e.message))
}
