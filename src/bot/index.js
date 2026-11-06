import cron from 'node-cron'
import { env } from '../config/env.js'
import { broadcast, runRemindersOnce } from './reminders.js'
import { pruneNotices, runAgentOnce, runEvening, runMorning } from './agent/index.js'
import { drain, startPolling } from './updates.js'
import { whoAmI } from './telegram.js'

const MSK = { timezone: 'Europe/Moscow' }

/**
 * Сообщения по расписанию, одинаковые для всех. Уходят лично каждому, кто
 * подключил телеграм: общего чата у нас нет.
 *
 * Только по будням (1-5): в выходные ни дейлика, ни звонка нет, и
 * напоминание про задачи в субботу выглядело бы странно.
 *
 * Дневные пинги в 12:00, 15:00 и 18:45/18:55 убрали: одинаковые сообщения
 * каждый день читались как спам. Утренний пинг 9:40 тоже убран: вместо него
 * утренний обход (agent/morning.js), агент пишет каждому своё. В 18:00 пишем
 * только тем, у кого остались незакрытые задачи на сегодня (agent/tasks.js),
 * напоминания о звонке идут из reminders.js.
 *
 * Тексты держим здесь целиком и без разметки: тег <b> или случайная
 * угловая скобка в HTML-режиме телеграм отвергает вместе со всем
 * сообщением.
 */
export const DAILY = []

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
    // Неверный токен или телеграм недоступен не должны мешать работе CRM:
    // ругаемся, живём дальше и пробуем снова через 5 минут.
    console.error('[бот] не запустился, повтор через 5 минут:', e.message)
    setTimeout(() => startBot().catch((err) => console.error('[бот] запуск:', err.message)), 5 * 60 * 1000)
    return
  }

  startPolling()
  // Выкладка на Render: дождаться ответов агента на начатые сообщения.
  process.once('SIGTERM', () => {
    console.log('[бот] остановка: дожидаюсь начатых ответов')
    drain(25000).finally(() => process.exit(0))
  })

  cron.schedule('* * * * *', () => {
    runRemindersOnce().catch((e) => console.error('[бот] напоминания:', e.message))
    runAgentOnce().catch((e) => console.error('[агент] проход:', e.message))
  }, MSK)

  // 9:40 по будням — утренний обход, каждому лично. Отчёт в 10:10 пришлёт минутный проход.
  cron.schedule('40 9 * * 1-5', () => {
    runMorning().catch((e) => console.error('[агент] утренний обход:', e.message))
  }, MSK)
  // 18:00 по будням — тем, у кого остались незакрытые задачи на сегодня.
  cron.schedule('0 18 * * 1-5', () => {
    runEvening().catch((e) => console.error('[агент] вечер:', e.message))
  }, MSK)
  cron.schedule('30 3 * * *', () => {
    pruneNotices().catch((e) => console.error('[агент] уборка:', e.message))
  }, MSK)

  for (const { at, text } of DAILY) {
    cron.schedule(at, () => {
      broadcast(text).catch((e) => console.error('[бот] расписание:', e.message))
    }, MSK)
  }

  console.log(`[бот] @${username} запущен, напоминание за ${env.remindBeforeMin} мин`)
  if (env.anthropicKeyMalformed) console.error('[ИИ] ANTHROPIC_API_KEY в неверном формате (пробелы или лишние символы) — ИИ выключен')
  else console.log(env.anthropicApiKey ? `[ИИ] ключ задан, агент ${env.aiModel}, запасная ${env.aiFallbackModel}, бюджет $${env.aiDailyUsd} в день и $${env.aiMonthlyUsd} в месяц` : '[ИИ] ключа нет — бот работает по правилам')
}
