import { prisma } from '../config/prisma.js'
import { escapeHtml, getUpdates, sendMessage } from './telegram.js'

const HELP =
  'Я напоминаю о звонках из CRM.\n\n' +
  'Чтобы я знал, кому писать, зайдите в CRM → Настройки → ' +
  '«Подключить телеграм». Оттуда вы вернётесь сюда, и всё свяжется само.'

/**
 * Нас интересует одна команда — /start с кодом из ссылки, которую выдаёт
 * CRM. Код доказывает, кто перед нами: получить его может только тот, кто
 * уже вошёл в CRM под собой, поэтому ни почту, ни имя спрашивать не нужно
 * и назваться чужим невозможно.
 */
async function handleMessage(msg) {
  const chatId = msg.chat?.id
  const text = String(msg.text || '').trim()
  if (!chatId) return

  if (!text.startsWith('/start')) {
    await sendMessage(chatId, HELP)
    return
  }

  const code = text.slice('/start'.length).trim()
  if (!code) {
    await sendMessage(chatId, HELP)
    return
  }

  const link = await prisma.telegramLink.findUnique({
    where: { code },
    include: { user: { select: { name: true, active: true } } },
  })

  if (!link || !link.user?.active || !link.codeExpiresAt || link.codeExpiresAt < new Date()) {
    await sendMessage(
      chatId,
      'Ссылка не подошла — скорее всего, истекла.\n\n' +
      'Откройте CRM → Настройки → «Подключить телеграм» и нажмите кнопку заново.',
    )
    return
  }

  // Код гасим сразу: ссылка одноразовая, иначе ею мог бы
  // воспользоваться кто-то ещё.
  await prisma.telegramLink.update({
    where: { userId: link.userId },
    data: {
      chatId: String(chatId),
      username: msg.from?.username || null,
      linkedAt: new Date(),
      code: null,
      codeExpiresAt: null,
    },
  })

  await sendMessage(
    chatId,
    `Готово, ${escapeHtml(String(link.user.name || '').split(' ')[0] || 'коллега')}.\n\n` +
    'Теперь я напомню о каждом звонке за пятнадцать минут — и о тех, что ставите вы, ' +
    'и о тех, куда вас позвали.',
  )
  console.log(`[бот] ${link.user.name} подключил телеграм`)
}

/**
 * Длинный опрос вместо вебхука: серверу не нужен отдельный публичный
 * маршрут, а обрыв связи не роняет процесс — ждём и пробуем снова.
 */
export function startPolling() {
  let offset = 0
  ;(async () => {
    for (;;) {
      try {
        const updates = await getUpdates(offset)
        for (const u of updates) {
          offset = u.update_id + 1
          if (u.message) await handleMessage(u.message).catch((e) => console.error('[бот] связка:', e.message))
        }
      } catch (e) {
        console.error('[бот] опрос:', e.message)
        await new Promise((r) => setTimeout(r, 5000))
      }
    }
  })()
}
