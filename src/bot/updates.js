import { prisma } from '../config/prisma.js'
import { env } from '../config/env.js'
import { escapeHtml, answerCallback, getUpdates, sendMessage } from './telegram.js'
import { onCallback, onText } from './agent/router.js'
import { MENU } from './agent/away.js'
import { userByChat } from './agent/notify.js'

const HELP =
  'Привет. Я бот KOMETA.\n\n' +
  'Чтобы я знал, кому писать, зайдите в CRM, откройте Настройки и нажмите «Подключить телеграм».\n' +
  'Оттуда вы вернётесь сюда, и всё свяжется само.'

/**
 * Нас интересует одна команда — /start с кодом из ссылки, которую выдаёт
 * CRM. Код доказывает, кто перед нами: получить его может только тот, кто
 * уже вошёл в CRM под собой, поэтому ни почту, ни имя спрашивать не нужно
 * и назваться чужим невозможно.
 */
// Что прислали вместо текста — для журнала и как ответ на чек-ин.
const MEDIA = [
  ['voice', 'голосовое'], ['video_note', 'кружок'], ['photo', 'фото'], ['video', 'видео'], ['document', 'файл'],
  ['sticker', 'стикер'], ['audio', 'аудио'], ['location', 'геопозиция'], ['contact', 'контакт'], ['poll', 'опрос'], ['dice', 'кубик'],
]

// Чужим, кого нет в CRM, отвечаем подсказкой не чаще раза в сутки, а
// остальное молча пропускаем: ни ИИ, ни журнала, ни потока ответов на спам.
// В памяти, а не в базе: чужие не должны писать в базу.
const STRANGER_REPLY_MS = 24 * 60 * 60 * 1000
const STRANGERS_MAX = 5000
const strangers = new Map()

export function shouldAnswerStranger(chatId, now = Date.now()) {
  const last = strangers.get(String(chatId))
  if (last && now - last < STRANGER_REPLY_MS) return false
  if (strangers.size >= STRANGERS_MAX) strangers.clear()
  strangers.set(String(chatId), now)
  return true
}

// Фото у телеграма в нескольких размерах. Модели хватает 1600 точек по
// длинной стороне, больше она всё равно уменьшит, а качать дольше.
const PHOTO_MAX_SIDE = 1600
const FILE_KINDS = ['animation', 'video', 'video_note', 'voice', 'audio', 'document']

/** Файлы сообщения: { fileId, kind, mime }. */
export function filesOf(msg) {
  if (msg.photo?.length) {
    const sizes = [...msg.photo].sort((a, b) => (a.width * a.height) - (b.width * b.height))
    const fit = sizes.filter((p) => Math.max(p.width, p.height) <= PHOTO_MAX_SIDE).at(-1) ?? sizes[0]
    return [{ fileId: fit.file_id, kind: 'photo', mime: 'image/jpeg' }]
  }
  const kind = FILE_KINDS.find((k) => msg[k]?.file_id)
  return kind ? [{ fileId: msg[kind].file_id, kind, mime: msg[kind].mime_type ?? null }] : []
}

async function handleMessage(msg, files = filesOf(msg)) {
  const chatId = msg.chat?.id
  // Другие боты нам не пишут — не отвечаем.
  if (msg.from?.is_bot) return
  // Подпись к фото — тоже текст.
  const text = String(msg.text || msg.caption || '').trim()
  const media = MEDIA.find(([key]) => msg[key])?.[1] ?? null
  // Только личная переписка: в группе бот не работает — общего чата нет.
  if (!chatId || msg.chat?.type !== 'private') return

  const code = text.startsWith('/start') ? text.slice('/start'.length).trim() : ''
  if (!code) {
    // Уже подключённый человек — дальше разговор ведёт агент.
    const user = await userByChat(chatId)
    if (user) return onText(user, chatId, text, new Date(), { media, files })
    if (shouldAnswerStranger(chatId)) await sendMessage(chatId, HELP)
    return
  }

  const link = await prisma.telegramLink.findUnique({
    where: { code },
    include: { user: { select: { name: true, active: true, role: true } } },
  })

  if (!link || !link.user?.active || !link.codeExpiresAt || link.codeExpiresAt < new Date()) {
    await sendMessage(
      chatId,
      'Ссылка не подошла, скорее всего, она истекла.\n\n' +
      'Откройте в CRM Настройки и нажмите «Подключить телеграм» заново.',
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
    'Теперь я напомню о каждом звонке за 15 и за 5 минут.\n\n' +
    (link.user.role === 'admin'
      ? 'Сюда же будут приходить отчёты по команде.\nРешения принимаются кнопками под сообщениями.'
      : 'Если отходишь, напиши мне, например, <i>отхожу на 30 минут</i> или <i>буду в 16:30</i>.\n' +
        'Когда вернёшься, напиши <i>вернулся</i> или нажми кнопку ниже.'),
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
    await answerCallback(cb.id, 'Сначала подключите телеграм в настройках CRM')
    return
  }
  await onCallback(cb, user)
}

/**
 * Очередь на каждый чат: сообщения одного человека — строго по порядку, а
 * разные люди друг друга не ждут. Агент думает до минуты, и без этого
 * один длинный ответ держал бы бота для всех.
 */
const chains = new Map()
export function enqueue(chatId, job) {
  const key = String(chatId ?? '')
  const next = (chains.get(key) ?? Promise.resolve())
    .then(job)
    .catch((e) => console.error('[бот] обработка:', e.message))
    .finally(() => {
      if (chains.get(key) === next) chains.delete(key)
    })
  chains.set(key, next)
  return next
}

/**
 * Альбом телеграм присылает отдельными сообщениями подряд. Ждём полторы
 * секунды и отдаём агенту одним сообщением: иначе он ответил бы на каждое
 * фото по отдельности.
 */
const ALBUM_WAIT_MS = 1500
const albums = new Map()
function takeAlbumPart(msg) {
  const key = `${msg.chat?.id}:${msg.media_group_id}`
  const album = albums.get(key) ?? { parts: [], timer: null }
  album.parts.push(msg)
  clearTimeout(album.timer)
  album.flush = () => {
    albums.delete(key)
    const parts = album.parts.sort((a, b) => a.message_id - b.message_id)
    const head = parts.find((m) => m.caption) ?? parts[0]
    enqueue(head.chat?.id, () => handleMessage(head, parts.flatMap(filesOf)))
  }
  album.timer = setTimeout(album.flush, ALBUM_WAIT_MS)
  albums.set(key, album)
}

function dispatch(u) {
  if (u.message?.media_group_id) return takeAlbumPart(u.message)
  if (u.message) return enqueue(u.message.chat?.id, () => handleMessage(u.message))
  if (u.callback_query) return enqueue(u.callback_query.message?.chat?.id, () => handleCallback(u.callback_query))
  return null
}

/**
 * Длинный опрос вместо вебхука: серверу не нужен отдельный публичный
 * маршрут, а обрыв связи не роняет процесс — ждём и пробуем снова.
 */
let stopping = false

export function startPolling() {
  let offset = 0
  ;(async () => {
    while (!stopping) {
      try {
        const updates = await getUpdates(offset)
        // Сервер останавливается — не берём: телеграм пришлёт это снова
        // после перезапуска, раз следующего запроса с offset не было.
        if (stopping) break
        for (const u of updates) {
          offset = u.update_id + 1
          dispatch(u)
        }
      } catch (e) {
        // Кривой адрес сеть пишет в ошибку целиком — вместе с токеном.
        console.error('[бот] опрос:', String(e.message).split(env.telegramBotToken || '\u0000').join('[токен]'))
        await new Promise((r) => setTimeout(r, 5000))
      }
    }
  })()
}

/**
 * Перезапуск сервера (Render шлёт SIGTERM при выкладке): новые сообщения
 * больше не берём, альбомы отдаём сразу и ждём, пока агент ответит на
 * начатые, но не дольше ms. Иначе сообщение, на которое агент думал минуту,
 * пропало бы без ответа.
 */
export async function drain(ms = 25000) {
  stopping = true
  for (const album of albums.values()) {
    clearTimeout(album.timer)
    album.flush()
  }
  await Promise.race([
    Promise.allSettled([...chains.values()]),
    new Promise((r) => setTimeout(r, ms)),
  ])
}
