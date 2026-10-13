import { prisma } from '../config/prisma.js'
import { escapeHtml, answerCallback, getUpdates, sendMessage } from './telegram.js'
import { onCallback, onText } from './agent/router.js'
import { MENU } from './agent/away.js'
import { userByChat } from './agent/notify.js'

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
  // Только личная переписка: в группе бот не работает — общего чата нет.
  if (!chatId || msg.chat?.type !== 'private') return

  const code = text.startsWith('/start') ? text.slice('/start'.length).trim() : ''
  if (!code) {
    // Уже подключённый человек — дальше разговор ведёт агент.
    const user = await userByChat(chatId)
    if (user) return onText(user, chatId, text)
    await sendMessage(chatId, HELP)
    return
  }

  const link = await prisma.telegramLink.findUnique({
    where: { code },
    include: { user: { select: { name: true, active: true, role: true } } },
  })

  if (!link || !link.user?.active || !link.codeExpiresAt || link.codeExpiresAt < new Date()) {
    await sendMessage(
      chatId,
      'Ссылка не подошла — скорее всего, истекла.\n\n' +
      'Откройте CRM → Настройки → «Подключить телеграм» и нажмите кнопку заново.',
    )
    return
  }

  // Один чат — один человек: если этот телеграм был привязан к другому
  // аккаунту CRM, там связь снимаем, иначе непонятно, кто нажимает кнопки.
  await prisma.telegramLink.updateMany({
    where: { chatId: String(chatId), userId: { not: link.userId } },
    data: { chatId: null, username: null, linkedAt: null },
  })

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
    'и о тех, куда вас позвали.\n\n' +
    (link.user.role === 'admin'
      ? 'Сюда же придут отчёты: кто отошёл и вернулся, форс-мажоры, чек-ины и заявки «На проверке».'
      : 'Отходишь — напиши мне, например «отхожу на 30 минут» или «буду в 16:30», ' +
        'а когда вернёшься — «вернулся». Или кнопками:'),
    { buttons: link.user.role === 'admin' ? undefined : MENU },
  )
  console.log(`[бот] ${link.user.name} подключил телеграм`)
}

/** Нажатие кнопки. Кто нажал — по связке чата с CRM. */
async function handleCallback(cb) {
  const chatId = cb.message?.chat?.id
  // Нажал тот, чей это чат, и только в личной переписке.
  if (!chatId || cb.message?.chat?.type !== 'private' || String(cb.from?.id) !== String(chatId)) {
    await answerCallback(cb.id)
    return
  }
  const user = await userByChat(chatId)
  if (!user) {
    await answerCallback(cb.id, 'Сначала подключите телеграм в CRM → Настройки')
    return
  }
  await onCallback(cb, user)
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
          if (u.message) await handleMessage(u.message).catch((e) => console.error('[бот] сообщение:', e.message))
          if (u.callback_query) await handleCallback(u.callback_query).catch((e) => console.error('[бот] кнопка:', e.message))
        }
      } catch (e) {
        console.error('[бот] опрос:', e.message)
        await new Promise((r) => setTimeout(r, 5000))
      }
    }
  })()
}
