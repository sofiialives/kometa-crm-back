import { prisma } from '../../config/prisma.js'
import { escapeHtml } from '../telegram.js'
import { at, short } from './format.js'
import { claimNotice, tell } from './notify.js'
import * as state from './state.js'

/**
 * Напоминания по просьбе человека: «напомни в 15:00 позвонить клиенту»,
 * «через 20 минут напомни про отчёт». Время не назвал — бот переспрашивает
 * кнопками. Уходит один раз, отменить можно кнопкой. Яну не пишем — это
 * личное дело человека.
 */

const MAX_ACTIVE = 10
const MAX_AHEAD_MS = 24 * 60 * 60 * 1000
export const REMIND_MINUTES = [15, 30, 60, 120]

/** Текст напоминания без «напомни мне» и без времени в начале. */
export function reminderText(text) {
  const t = String(text ?? '')
    .replace(/(пожалуйста,?\s*)?напомни(те|ть)?(\s+(мне|нам))?[\s,:]*/gi, ' ')
    .trim()
    .replace(/^(в|к|около|через|до)\s+\S+(\s+(минут\w*|час\w*|мин))?[\s,]*/i, '')
    .replace(/^(чтобы|что|про|о|об)\s+/i, '')
    .trim()
  return short(t || 'то, о чём просил(а)', 300)
}

/** Поставить напоминание. Возвращает созданное или null (уже ответили почему). */
export async function createReminder(user, when, text, now = new Date()) {
  state.clear(user.id)
  const ms = new Date(when).getTime() - now.getTime()
  if (!(ms >= 60000 && ms <= MAX_AHEAD_MS)) {
    await tell(user.id, 'Напомнить могу в пределах суток — напиши время, например «напомни в 16:30 позвонить клиенту».')
    return null
  }
  const active = await prisma.botReminder.count({ where: { userId: user.id, sentAt: null, cancelledAt: null, at: { gt: now } } })
  if (active >= MAX_ACTIVE) {
    await tell(user.id, `У тебя уже ${active} напоминаний — больше не держу. Дождись ближайших или отмени лишние кнопкой «Отменить».`)
    return null
  }
  const reminder = await prisma.botReminder.create({ data: { userId: user.id, at: new Date(when), text: reminderText(text) } })
  await tell(user.id, `⏰ Напомню в <b>${at(reminder.at, now)}</b>: ${escapeHtml(reminder.text)}`, {
    buttons: [[{ text: 'Отменить', data: `rm:x:${reminder.id}` }]],
  })
  return reminder
}

/** Время не названо — спросить кнопками (текст держим в ожидании ответа). */
export async function askReminderTime(user, text) {
  state.expect(user.id, 'remind_time', { text })
  await tell(user.id, 'Когда напомнить? Нажми кнопку или напиши время, например «в 16:30».', {
    buttons: [[
      { text: 'через 15 мин', data: 'rmt:15' },
      { text: '30 мин', data: 'rmt:30' },
      { text: '1 час', data: 'rmt:60' },
      { text: '2 часа', data: 'rmt:120' },
    ]],
  })
}

/** Кнопка «Отменить» под напоминанием. */
export async function cancelReminder(user, id, now = new Date()) {
  const updated = await prisma.botReminder.updateMany({
    where: { id, userId: user.id, sentAt: null, cancelledAt: null },
    data: { cancelledAt: now },
  })
  return updated.count > 0
}

/** Раз в минуту: подошедшие напоминания. Проспанные больше 6 часов — молча закрываем. */
export async function tickReminders(now = new Date()) {
  const due = await prisma.botReminder.findMany({
    where: { sentAt: null, cancelledAt: null, at: { lte: now } },
    orderBy: { at: 'asc' },
    take: 50,
  })
  for (const r of due) {
    const claimed = await prisma.botReminder.updateMany({ where: { id: r.id, sentAt: null }, data: { sentAt: now } })
    if (!claimed.count) continue
    if (now.getTime() - r.at.getTime() > 6 * 60 * 60 * 1000) continue
    if (!(await claimNotice(`reminder:${r.id}`))) continue
    await tell(r.userId, `⏰ Напоминаю: ${escapeHtml(r.text)}`)
  }
}
