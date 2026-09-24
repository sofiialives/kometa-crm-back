import { prisma } from '../config/prisma.js'
import { env } from '../config/env.js'
import { escapeHtml, sendMessage } from './telegram.js'

/**
 * Сообщения о самом факте звонка: позвали, перенесли, отменили, сняли.
 *
 * Это не напоминания — те уходят за пятнадцать минут и живут в
 * reminders.js. Здесь другое: человек должен узнать, что звонок вообще
 * появился, в момент, когда его поставили, а не за четверть часа до
 * начала, когда переигрывать уже поздно.
 *
 * Ни одна ошибка отсюда не должна ронять запрос: звонок в CRM создан, и
 * недоставленное сообщение — повод для строки в логе, а не для отказа.
 */

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000

const mskDay = (date) => new Date(new Date(date).getTime() + MSK_OFFSET_MS).toISOString().slice(0, 10)

/**
 * «сегодня в 20:00», «завтра в 11:30», «26 сентября в 15:00».
 * Ближние дни словом: так быстрее считывается, а именно скорость здесь
 * и нужна — человек читает сообщение на бегу.
 */
function whenText(date) {
  const d = new Date(new Date(date).getTime() + MSK_OFFSET_MS)
  const time = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`

  const today = mskDay(new Date())
  const tomorrow = mskDay(new Date(Date.now() + 24 * 60 * 60 * 1000))
  const day = mskDay(date)

  if (day === today) return `сегодня в ${time}`
  if (day === tomorrow) return `завтра в ${time}`

  const label = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' })
  return `${label} в ${time}`
}

/** Кому реально можно написать: подключил телеграм и ещё работает. */
async function chatsOf(userIds) {
  const ids = [...new Set(userIds)].filter(Boolean)
  if (ids.length === 0) return []

  const links = await prisma.telegramLink.findMany({
    where: { userId: { in: ids }, chatId: { not: null }, user: { active: true } },
    select: { chatId: true, user: { select: { name: true } } },
  })
  return links
}

async function send(userIds, text) {
  if (!env.telegramBotToken) return
  const links = await chatsOf(userIds)
  for (const l of links) await sendMessage(l.chatId, text)
}

const fireAndForget = (promise, what) =>
  promise.catch((e) => console.error(`[бот] ${what}:`, e.message))

function callBlock(call) {
  const lines = [`<b>${escapeHtml(call.title)}</b>`, whenText(call.scheduledAt)]
  if (call.note) lines.push('', escapeHtml(call.note))
  return lines.join('\n')
}

/**
 * Остальные участники — «с кем именно созвон».
 *
 * Организатора сюда не берём: в приглашении он уже назван строкой выше,
 * и второй раз перечислять его значит заставлять читать одно и то же.
 */
function others(call, exceptId) {
  const people = (call.participants || [])
    .filter((p) => p && p.id !== exceptId)
    .map((p) => escapeHtml(p.name))
  return people.length ? `\n\nВместе с вами: ${people.join(', ')}` : ''
}

/**
 * Позвали на звонок. Уходит только тем, кого позвали именно сейчас:
 * организатор и так знает, а участникам, которые были в звонке раньше,
 * второй раз писать незачем.
 */
export function notifyInvited(call, invitedIds) {
  if (!invitedIds?.length) return
  fireAndForget((async () => {
    for (const id of invitedIds) {
      const text =
        `<b>${escapeHtml(call.owner?.name || 'Коллега')}</b> зовёт вас на звонок\n\n` +
        `${callBlock(call)}` +
        `${others(call, id)}\n\n` +
        `<i>Напомню ещё раз за ${env.remindBeforeMin} минут до начала.</i>`
      await send([id], text)
    }
  })(), 'приглашение на звонок')
}

/**
 * Время сдвинулось. Без этого сообщения приглашение начинает врать:
 * человек помнит старое время и узнаёт правду за пятнадцать минут до
 * нового — или после того, как звонок прошёл без него.
 */
export function notifyTimeChanged(call, previousAt, skipIds = []) {
  // Тот, кого позвали этой же правкой, старого времени не знал — ему
  // «было/стало» только запутает. Он уже получил приглашение с новым.
  const ids = (call.participants || []).map((p) => p.id).filter((id) => !skipIds.includes(id))
  if (!ids.length) return
  fireAndForget(send(ids,
    `<b>Звонок перенесли</b>\n\n` +
    `<b>${escapeHtml(call.title)}</b>\n` +
    `было: ${whenText(previousAt)}\n` +
    `стало: ${whenText(call.scheduledAt)}\n\n` +
    `<i>Перенёс ${escapeHtml(call.owner?.name || 'организатор')}.</i>`,
  ), 'перенос звонка')
}

/** Звонок отменили. Иначе люди придут на созвон, которого нет. */
export function notifyCancelled(call) {
  const ids = (call.participants || []).map((p) => p.id)
  if (!ids.length) return
  fireAndForget(send(ids,
    `<b>Звонок отменили</b>\n\n` +
    `<b>${escapeHtml(call.title)}</b>\n` +
    `${whenText(call.scheduledAt)}\n\n` +
    `<i>Отменил ${escapeHtml(call.owner?.name || 'организатор')}.</i>`,
  ), 'отмена звонка')
}

/** Сняли со звонка — чтобы человек не готовился к тому, чего от него уже не ждут. */
export function notifyRemoved(call, removedIds) {
  if (!removedIds?.length) return
  fireAndForget(send(removedIds,
    `<b>Вас сняли со звонка</b>\n\n` +
    `<b>${escapeHtml(call.title)}</b>\n` +
    `${whenText(call.scheduledAt)}\n\n` +
    `<i>Звонок остаётся, но без вас. Напоминание не придёт.</i>`,
  ), 'снятие со звонка')
}
