import { prisma } from '../../config/prisma.js'
import { escapeHtml } from '../telegram.js'
import { at, short } from './format.js'
import { tell } from './notify.js'
import * as state from './state.js'

/**
 * Напоминания по просьбе человека: «напомни в 15:00 позвонить клиенту»,
 * «через 20 минут напомни про отчёт», «напомни завтра в 10 про звонок».
 * Сегодня или завтра — дальше не держим. Время не назвал — бот
 * переспрашивает. Уходит один раз, отменить можно кнопкой. Яну не пишем —
 * это личное дело человека.
 */

const MAX_ACTIVE = 10
// «Завтра в 23:00», сказанное сразу после полуночи, — почти двое суток.
const MAX_AHEAD_MS = 48 * 60 * 60 * 1000
// Бот лежал дольше — старое напоминание уже не к месту, закрываем без отправки.
const STALE_MS = 6 * 60 * 60 * 1000
// Опоздали больше чем на 15 минут — честно пишем, на когда было.
const LATE_NOTE_MS = 15 * 60 * 1000
export const REMIND_MINUTES = [15, 30, 60, 120]

// Что срезаем в начале текста напоминания, по кругу, пока срезается:
// вежливость, день, время («через 2 минуты», «в 15:30»), связки («о том,
// что»). Время — только числом или словом-числом: «в офисе взять ключи»
// остаётся как есть. \w в JS не видит кириллицу — поэтому [а-яё].
const LEADING = [
  /^(пожалуйста|плиз)[\s,]*/i,
  /^(сегодня|завтра)[\s,]+/i,
  /^(в|к|около|через|до)\s+(\d[\d:.,]*|полчаса|полтора|час|минуту|пару|одну|один|два|две|три|четыре|пять|десять|пятнадцать|двадцать|тридцать|сорок|пятьдесят)(\s+(минут[а-яё]*|час[а-яё]*|мин\.?))?[\s,]*/i,
  /^(о том|про то|об этом)[\s,]*((что|чтобы)\s+)?/i,
  /^(чтобы|что|про|о|об)\s+/i,
]

/** Текст напоминания без «напомни мне», времени и связок в начале. */
export function reminderText(text) {
  let t = String(text ?? '')
    .replace(/(пожалуйста,?\s*)?напомни(те|ть)?(\s+(мне|нам))?[\s,:]*/gi, ' ')
    .trim()
  for (let i = 0; i < 6; i += 1) {
    const before = t
    for (const re of LEADING) t = t.replace(re, '').trim()
    if (t === before) break
  }
  return short(t || 'то, о чём просил(а)', 300)
}

/** Поставить напоминание. Возвращает созданное или null (уже ответили почему). */
export async function createReminder(user, when, text, now = new Date()) {
  state.clear(user.id)
  const ms = new Date(when).getTime() - now.getTime()
  if (!(ms >= 60000)) {
    await tell(user.id, 'Это уже прямо сейчас 🙂 Назови время хотя бы через минуту.')
    return null
  }
  if (ms > MAX_AHEAD_MS) {
    await tell(user.id, FAR_TEXT)
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

const FAR_TEXT = 'Напомнить могу сегодня или завтра — дальше не держу. Напиши, например, «напомни завтра в 10:00 позвонить клиенту».'

/** «В пятницу», «через неделю» — так далеко не напоминаем. */
export async function tooFarReminder(user) {
  state.clear(user.id)
  await tell(user.id, FAR_TEXT)
}

/**
 * Время не названо — спросить (текст держим в ожидании ответа). Сказал
 * «завтра» без времени — кнопки «через 15 мин» не к месту, просим время.
 */
export async function askReminderTime(user, text, { tomorrow = false } = {}) {
  state.expect(user.id, 'remind_time', { text, tomorrow })
  if (tomorrow) {
    await tell(user.id, 'Во сколько завтра напомнить? Напиши время, например «в 10:00».')
    return
  }
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

/**
 * Раз в минуту: подошедшие напоминания. Захват — атомарный updateMany по
 * sentAt: два процесса одно напоминание не отправят. Временный сбой
 * телеграма — снимаем отметку, повторим на следующем проходе. Проспанные
 * больше 6 часов закрываем без отправки.
 */
export async function tickReminders(now = new Date()) {
  const due = await prisma.botReminder.findMany({
    where: { sentAt: null, cancelledAt: null, at: { lte: now } },
    orderBy: { at: 'asc' },
    take: 50,
  })
  for (const r of due) {
    const claimed = await prisma.botReminder.updateMany({ where: { id: r.id, sentAt: null }, data: { sentAt: now } })
    if (!claimed.count) continue
    const lateMs = now.getTime() - r.at.getTime()
    if (lateMs > STALE_MS) continue
    const note = lateMs > LATE_NOTE_MS ? ` <i>(с опозданием — было на ${at(r.at, now)})</i>` : ''
    const res = await tell(r.userId, `⏰ Напоминаю: ${escapeHtml(r.text)}${note}`)
    if (!res?.ok && res?.retry) await prisma.botReminder.updateMany({ where: { id: r.id, sentAt: now }, data: { sentAt: null } })
  }
}
