import { prisma } from '../config/prisma.js'
import { env } from '../config/env.js'
import { escapeHtml, sendMessage } from './telegram.js'

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000

/** Время звонка по Москве — в CRM оно показывается именно так. */
function mskTime(date) {
  const d = new Date(new Date(date).getTime() + MSK_OFFSET_MS)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

const firstName = (full) => String(full || '').trim().split(/\s+/)[0] || 'Привет'

/**
 * Сообщение пишется каждому лично, поэтому и обращение личное, и список
 * участников — «с кем вы созваниваетесь», без себя самого.
 */
export function buildReminder(call, person, everyone, minutes = env.remindBeforeMin) {
  const others = everyone.filter((p) => p.id !== person.id).map((p) => escapeHtml(p.name))

  const lines = [
    `${escapeHtml(firstName(person.name))}, через ${minutes} мин звонок в <b>${mskTime(call.scheduledAt)}</b>`,
    '',
    `<b>${escapeHtml(call.title)}</b>`,
  ]
  if (call.note) lines.push(escapeHtml(call.note))
  if (others.length) lines.push('', `Вместе с вами ${others.join(', ')}`)
  if (person.id !== call.ownerId) lines.push('', '<i>Вас позвали на этот звонок</i>')

  return lines.join('\n')
}

// Второе напоминание — за 5 минут: Ян просил, чтобы о звонке напоминали дважды.
const LAST_CALL_MIN = 5

/**
 * Звонки, до которых осталось ровно minutes минут.
 *
 * Окно в минуту при запуске раз в минуту даёт ровно одно напоминание на
 * звонок: раньше он в окно не попадёт, позже уже выйдет из него. Отметки
 * «уже напомнили» в базе поэтому не нужно.
 */
async function dueCalls(minutes) {
  const from = new Date(Date.now() + minutes * 60 * 1000)
  const to = new Date(from.getTime() + 60 * 1000)

  return prisma.call.findMany({
    where: { scheduledAt: { gte: from, lt: to } },
    include: {
      owner: { select: { id: true, name: true, active: true, telegram: { select: { chatId: true } } } },
      participants: { select: { id: true, name: true, active: true, telegram: { select: { chatId: true } } } },
    },
  })
}

/**
 * Один проход: найти подошедшие звонки и написать каждому участнику.
 * Кто не подключил телеграм — пропускается, но попадает в лог, иначе
 * непонятно, почему человек ничего не получает.
 */
export async function runRemindersOnce() {
  let sent = 0
  for (const minutes of [...new Set([env.remindBeforeMin, LAST_CALL_MIN])]) {
    sent += await remindAt(minutes)
  }
  return { sent }
}

async function remindAt(minutes) {
  const calls = await dueCalls(minutes)
  if (calls.length === 0) return 0
  const away = await forceMajeureIds()

  let sent = 0
  const skipped = new Set()

  for (const call of calls) {
    const people = [call.owner, ...call.participants].filter((p) => p?.active)
    for (const person of people) {
      if (away.has(person.id)) continue
      const chatId = person.telegram?.chatId
      if (!chatId) {
        skipped.add(person.name)
        continue
      }
      const res = await sendMessage(chatId, buildReminder(call, person, people, minutes))
      if (res.ok) sent += 1
    }
  }

  console.log(`[бот] за ${minutes} мин: звонков ${calls.length}, отправлено ${sent}` +
    (skipped.size ? `, без телеграма: ${[...skipped].join(', ')}` : ''))
  return sent
}

/**
 * У кого сейчас форс-мажор: таких бот не дёргает — ни рассылкой, ни
 * напоминанием о звонке, пока метка действует.
 */
export async function forceMajeureIds(now = new Date()) {
  const rows = await prisma.motivationAway.findMany({
    where: { kind: 'force_majeure', endedAt: null, from: { lte: now }, until: { gt: now } },
    select: { userId: true },
  })
  return new Set(rows.map((r) => r.userId))
}

/** Сообщения по расписанию — всем, кто подключился, кроме тех, у кого форс-мажор. */
export async function broadcast(text) {
  const [links, away] = await Promise.all([
    prisma.telegramLink.findMany({
      where: { chatId: { not: null }, user: { active: true } },
      select: { chatId: true, userId: true },
    }),
    forceMajeureIds(),
  ])
  const targets = links.filter((l) => !away.has(l.userId))
  for (const l of targets) await sendMessage(l.chatId, text)
  console.log(`[бот] рассылка по расписанию: ${targets.length}${away.size ? `, с форс-мажором пропущено ${links.length - targets.length}` : ''}`)
}
