import cron from 'node-cron'
import { env } from '../config/env.js'
import { broadcast, runRemindersOnce } from './reminders.js'
import { startPolling } from './updates.js'
import { whoAmI } from './telegram.js'

const MSK = { timezone: 'Europe/Moscow' }

/**
 * Сообщения по расписанию. Список держим здесь, чтобы поправить время
 * или текст можно было в одном месте.
 */
const DAILY = [
  { at: '40 9 * * 1-5', text: '🔔 <b>Скоро утренний дейлик</b>\nНе забываем!' },
  { at: '45 18 * * 1-5', text: '🔔 <b>Скоро вечерний звонок</b>' },
]

/**
 * Бот напоминаний живёт внутри этого же сервиса, а не отдельным: тот уже
 * работает круглосуточно, и второй платный сервис ради одной рассылки не
 * нужен. С CRM он делит процесс и базу, но не логику — весь его код
 * лежит в этой папке и ни во что больше не вмешивается.
 *
 * Без токена бот не запускается вовсе, а сервер работает как обычно.
 * Так локальная разработка не требует ни бота, ни токена.
 */
export async function startBot() {
  if (!env.telegramBotToken) {
    console.log('[бот] TELEGRAM_BOT_TOKEN не задан — напоминания выключены')
    return
  }

  let username
  try {
    username = await whoAmI()
  } catch (e) {
    // Неверный токен не должен мешать работе CRM: ругаемся и живём дальше.
    console.error('[бот] не запустился:', e.message)
    return
  }

  startPolling()

  cron.schedule('* * * * *', () => {
    runRemindersOnce().catch((e) => console.error('[бот] напоминания:', e.message))
  }, MSK)

  for (const { at, text } of DAILY) {
    cron.schedule(at, () => {
      broadcast(text).catch((e) => console.error('[бот] расписание:', e.message))
    }, MSK)
  }

  console.log(`[бот] @${username} запущен, напоминание за ${env.remindBeforeMin} мин`)
}
