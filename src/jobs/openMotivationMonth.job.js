import cron from 'node-cron'
import { prisma } from '../config/prisma.js'
import { currentMonthKey } from '../services/motivation/month.js'
import { ensureStartBank } from '../services/motivation/journal.js'
import { PARTICIPANT_ROLES } from '../services/motivation/access.js'

/**
 * Начало месяца мотивации: в полночь первого числа по Москве каждый
 * сотрудник и руководитель получает стартовую сумму банка своего профиля,
 * если владелец её задал.
 *
 * Без этого задания сумма появлялась бы только тогда, когда кто-то откроет
 * вкладку, — и зависела бы от того, кто и когда это сделал. Экран всё равно
 * проверяет её при чтении: если сервер в ту ночь не работал, сумма ляжет
 * при первом же просмотре. Повторный запуск ничего не дублирует.
 *
 * Пять минут после полуночи — с запасом после ночной уборки задач, чтобы
 * не делить с ней первые секунды суток.
 */
export async function openMonth(now = new Date()) {
  const monthKey = currentMonthKey(now)
  const staff = await prisma.user.findMany({
    where: { role: { in: PARTICIPANT_ROLES }, active: true },
    select: { id: true, active: true },
  })
  let created = 0
  for (const user of staff) {
    if (await ensureStartBank(user, monthKey, now)) created += 1
  }
  return { monthKey, created }
}

export function scheduleOpenMotivationMonth() {
  cron.schedule('5 0 1 * *', async () => {
    try {
      const { monthKey, created } = await openMonth()
      console.log(`[cron] мотивация: открыт месяц ${monthKey}, стартовых сумм: ${created}`)
    } catch (e) {
      console.error('[cron] мотивация: не удалось открыть месяц:', e.message)
    }
  }, { timezone: 'Europe/Moscow' })
}
