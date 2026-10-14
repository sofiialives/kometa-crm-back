import { prisma } from '../../config/prisma.js'
import { parseUntil } from '../parse.js'
import { isQuietHour, isWorkday, mskDayKey } from '../plan.js'
import { escapeHtml } from '../telegram.js'
import { at, duration, endOfDay, hm, minutesBetween } from './format.js'
import { claimNotice, hasNotice, logEvent, nameOf, releaseNotice, sendOnce, tell, tellOwners, unsentKeys } from './notify.js'
import * as state from './state.js'

/**
 * «Отхожу», «вернулся», «задерживаюсь», «форс-мажор».
 *
 * Отлучка — та же метка MotivationAway, что ставит владелец, только с
 * видом break и источником bot. Пока она действует, бот человека не
 * дёргает, а чек-ин не штрафует. Бот сам считает, сколько человека не
 * было, за несколько минут до конца спрашивает «ты на месте?», а если тот
 * пропал — сообщает Яну.
 *
 * Форс-мажор человек только заявляет: метку ставит Ян кнопкой «Подтвердить».
 */

const DEFAULT_BREAK_MIN = 60
// Отлучка из бота — не дольше 8 часов, как и во фразах (parse.js). Дольше —
// это уже форс-мажор, его подтверждает Ян.
const MAX_BREAK_MIN = 8 * 60
export const BREAK_MINUTES = [15, 30, 60, 120]
// Ответ на чек-ин, штраф по которому ждёт решения Яна по форс-мажору.
export const FM_PENDING = 'заявка на форс-мажор ждёт решения Яна'
// Отлучка кончилась так давно (или ночью), что «вернулся» утром — не
// возвращение из неё: закрываем тихо, без «не было 11 часов» Яну.
const STALE_BREAK_MIN = 3 * 60
const SILENT_AFTER_MIN = 15
const lockUser = (tx, userId) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}))`

export const MENU = [
  [{ text: 'Отхожу', data: 'm:away' }, { text: 'Я на месте', data: 'm:back' }],
  [{ text: 'Форс-мажор', data: 'm:fm' }],
]

const BREAK_BUTTONS = (prefix) => [[
  { text: '15 мин', data: `${prefix}:15` },
  { text: '30 мин', data: `${prefix}:30` },
  { text: '1 час', data: `${prefix}:60` },
  { text: '2 часа', data: `${prefix}:120` },
]]
const RETURN_BUTTONS = (awayId) => [[
  { text: 'Да, на месте', data: `rt:y:${awayId}` },
  { text: 'Задерживаюсь', data: `rt:l:${awayId}` },
]]

/** Действующая метка человека — любая: отлучка или форс-мажор. */
export function activeAway(userId, now = new Date(), db = prisma) {
  return db.motivationAway.findFirst({
    where: { userId, endedAt: null, from: { lte: now }, until: { gt: now } },
    orderBy: { until: 'desc' },
  })
}

/** Отлучка, из которой человек ещё не вернулся, — даже если срок прошёл. */
function openBreak(userId, now, db = prisma) {
  return db.motivationAway.findFirst({
    where: {
      userId, kind: 'break', endedAt: null, returnedAt: null,
      from: { gt: new Date(now.getTime() - 12 * 60 * 60 * 1000) },
    },
    orderBy: { from: 'desc' },
  })
}

/**
 * Отойти до until. Без времени — на час, и бот один раз переспросит
 * кнопками. Действует форс-мажор — отлучка не нужна, он и так прикрывает.
 *
 * extend — это «задерживаюсь»: продлеваем текущую отлучку, даже если её
 * срок уже вышел. Новое «отхожу» после давно истёкшей отлучки, из которой
 * человек не отметился, — новая отлучка: раз пишет, значит, вернулся.
 */
export async function startBreak(user, { until = null, note = null, extend = false } = {}, now = new Date()) {
  const timeGiven = Boolean(until)
  const end = until ?? new Date(now.getTime() + DEFAULT_BREAK_MIN * 60000)
  const minutes = minutesBetween(now, end)
  if (!(minutes >= 1 && minutes <= MAX_BREAK_MIN)) {
    await tell(user.id, 'Отлучку можно поставить от минуты до 8 часов.\nЕсли нужно дольше, напиши <i>форс-мажор</i> и что случилось.')
    return { type: 'invalid' }
  }

  const result = await prisma.$transaction(async (tx) => {
    await lockUser(tx, user.id)
    const current = await activeAway(user.id, now, tx)
    if (current?.kind === 'force_majeure') return { type: 'covered', away: current }
    let open = current?.kind === 'break' ? current : await openBreak(user.id, now, tx)
    if (open && !extend && open.until <= now) {
      await tx.motivationAway.update({ where: { id: open.id }, data: { returnedAt: now } })
      open = null
    }
    if (open) {
      // Двойное нажатие той же кнопки — ничего не меняем и Яну не пишем.
      if (Math.abs(open.until.getTime() - end.getTime()) < 60000) return { type: 'same', away: open }
      // Отошёл без времени и тут же уточнил — это не продление, а уточнение.
      const clarify = open.extensions === 0 && !open.returnAskedAt && minutesBetween(open.from, now) <= 10
      const away = await tx.motivationAway.update({
        where: { id: open.id },
        data: { until: end, returnAskedAt: null, extensions: clarify ? 0 : { increment: 1 } },
      })
      return { type: clarify ? 'clarified' : 'extended', away }
    }
    const away = await tx.motivationAway.create({
      data: {
        userId: user.id, from: now, until: end, reason: note?.slice(0, 200) || null,
        kind: 'break', source: 'bot', createdById: user.id,
      },
    })
    return { type: 'started', away }
  })

  const { away } = result
  if (result.type === 'started') await releaseNotice(`dayend:${mskDayKey(now)}:${user.id}`)
  if (result.type === 'covered') {
    await tell(user.id, `У тебя и так стоит форс-мажор до ${at(away.until, now)}.\nОтдыхай, я не дёргаю.`)
    return result
  }
  if (result.type === 'same') {
    await tell(user.id, `Принято, жду к <b>${hm(away.until)}</b>.`)
    return result
  }
  if (result.type === 'started') {
    if (timeGiven) {
      await tell(user.id, `Понял, жду к <b>${hm(away.until)}</b>.\nПеред концом спрошу, на месте ли ты.`)
    } else {
      state.expect(user.id, 'break_time', { awayId: away.id })
      await tell(user.id, 'На сколько отходишь?\nНажми кнопку или напиши время, например <i>до 16:30</i>.\nЕсли не ответишь, поставлю час.', { buttons: BREAK_BUTTONS('aw') })
    }
    await tellOwners(`<b>Отлучка до ${hm(away.until)}</b>\n${nameOf(user)}${timeGiven ? '' : '\nВремя не назвали, поставил час'}${note ? `\n<i>${escapeHtml(note.slice(0, 200))}</i>` : ''}`)
    return result
  }
  if (result.type === 'clarified') {
    await tell(user.id, `Принято, жду к <b>${hm(away.until)}</b>.`)
    await tellOwners(`<b>Отлучка до ${hm(away.until)}</b>\n${nameOf(user)}\nУточнение времени`)
    return result
  }
  await tell(user.id, `Хорошо, жду к <b>${hm(away.until)}</b>.`)
  await tellOwners(`<b>Отлучка продлена до ${hm(away.until)}</b>\n${nameOf(user)}\nПродление ${away.extensions}-е`)
  return result
}

/** Есть ли отлучка, из которой человек ещё не отметился. */
export async function hasOpenBreak(userId, now = new Date(), { recentMin = null } = {}) {
  const open = await openBreak(userId, now)
  if (!open) return false
  // recentMin — только действующая или закончившаяся не раньше стольких минут назад.
  return recentMin === null || minutesBetween(open.until, now) <= recentMin
}

/** Сказал ли человек сегодня «на сегодня всё»: чек-ин и задачи его больше не трогают. */
export function hasEndedDay(userId, now = new Date()) {
  return hasNotice(`dayend:${mskDayKey(now)}:${userId}`)
}

/** «Ухожу домой», «на сегодня всё» — закрываем отлучку, если была, и прощаемся. */
export async function dayEnd(user, now = new Date()) {
  state.clear(user.id)
  // В журнал — один раз за день, сколько бы раз ни прощался.
  if (await claimNotice(`dayend:${mskDayKey(now)}:${user.id}`)) await logEvent(user.id, 'day_end', { at: now })
  const open = await openBreak(user.id, now)
  if (open) {
    await prisma.motivationAway.update({
      where: { id: open.id },
      data: { returnedAt: now, endedAt: open.until > now ? now : null },
    })
  }
  await tell(user.id, 'Отметил, что на сегодня всё.\nХорошего вечера.')
}

/**
 * Кнопка «15 мин / 30 мин…» под вопросом «на сколько?» или «до скольки
 * задерживаешься?». Данные кнопки присылает телефон, их можно подделать —
 * поэтому только минуты с наших кнопок.
 */
export function setBreakMinutes(user, minutes, now = new Date(), { extend = false } = {}) {
  state.clear(user.id)
  if (!BREAK_MINUTES.includes(minutes)) return null
  return startBreak(user, { until: new Date(now.getTime() + minutes * 60000), extend }, now)
}

/** «Вернулся», «я на месте». */
export async function comeBack(user, now = new Date()) {
  state.clear(user.id)
  // Сказал «еду домой», а потом вернулся — день не закончен.
  await releaseNotice(`dayend:${mskDayKey(now)}:${user.id}`)
  const away = await prisma.$transaction(async (tx) => {
    await lockUser(tx, user.id)
    const open = await openBreak(user.id, now, tx)
    if (!open) return null
    return tx.motivationAway.update({
      where: { id: open.id },
      // Срок ещё не вышел — метка снимается сейчас; вышел — она и так кончилась.
      data: { returnedAt: now, endedAt: open.until > now ? now : null },
    })
  })
  if (!away) {
    await tell(user.id, 'Отметил, ты на месте.')
    return null
  }
  const late = minutesBetween(away.until, now)
  if (late > STALE_BREAK_MIN) {
    await tell(user.id, 'Отметил, ты на месте.')
    return away
  }
  const gone = duration(minutesBetween(away.from, now))
  await tell(user.id, `С возвращением. Тебя не было ${gone}.`)
  await tellOwners(`<b>Снова на месте</b>\n${nameOf(user)}\nНе было ${gone}${late > 1 ? `\nОпоздание ${duration(late)}, ждали к ${hm(away.until)}` : ''}`)
  return away
}

/** «Задерживаюсь» с отлучкой или без. Без времени — спрашиваем, до скольки. */
export async function runningLate(user, { until = null, text = '' } = {}, now = new Date()) {
  const open = await openBreak(user.id, now)
  if (open) {
    if (until) return startBreak(user, { until, extend: true }, now)
    state.expect(user.id, 'break_time', { awayId: open.id, extend: true })
    // «ax» — продление: кнопка помнит, что это «задерживаюсь», а не новая отлучка.
    await tell(user.id, 'До скольки задерживаешься?\nНажми кнопку или напиши время.', { buttons: BREAK_BUTTONS('ax') })
    return null
  }
  // Одно «задерживаюсь» в 10 минут: десять подряд Яну и в журнал не нужны.
  const bucket = Math.floor(now.getTime() / (10 * 60000))
  const res = await sendOnce(`late:${user.id}:${bucket}`, () =>
    tellOwners(`<b>Задержка${until ? ` до ${hm(until)}` : ''}</b>\n${nameOf(user)}\n<i>${escapeHtml(text.slice(0, 300))}</i>`))
  if (!res.skipped) await logEvent(user.id, 'late', { at: now, text, data: until ? { until: until.toISOString() } : null })
  await tell(user.id, res.skipped ? 'Я уже передал Яну, что ты задерживаешься.' : 'Понял, передал Яну.')
  return null
}

/**
 * Форс-мажор: человек описывает, бот передаёт Яну с кнопками. Пока Ян не
 * решил, заявка висит в BotNotice «fm-open:…», и чек-ин человека не штрафует.
 */
export async function reportForceMajeure(user, text, message, now = new Date()) {
  state.clear(user.id)
  if (!message) return
  const current = await activeAway(user.id, now)
  if (current?.kind === 'force_majeure') {
    await tell(user.id, `У тебя уже стоит форс-мажор до ${at(current.until, now)}.\nОтдыхай, я не дёргаю.`)
    return
  }
  if (await hasOpenForceMajeure(user.id, now)) {
    await tell(user.id, 'Твоя заявка на форс-мажор уже у Яна, жду его решения.')
    return
  }
  const until = parseUntil(text, now) ?? endOfDay(now)
  const res = await tellOwners(
    `<b>Форс-мажор</b>\n${nameOf(user)}\n<i>${escapeHtml(text.slice(0, 500))}</i>\n\nМетка будет до ${at(until, now)}`,
    { buttons: [[{ text: 'Подтвердить', data: `fm:y:${message.id}` }, { text: 'Не подтверждать', data: `fm:n:${message.id}` }]] },
  )
  if (!res.ok) {
    await tell(user.id, 'Не получилось передать Яну.\nНапиши ему, пожалуйста, напрямую.')
    return
  }
  await claimNotice(`fm-open:${user.id}:${message.id}`)
  await logEvent(user.id, 'fm_request', { at: now, text, data: { until: until.toISOString() } })
  await tell(user.id, 'Передал Яну.\nКак подтвердит, поставлю метку и до её конца не буду тебя трогать.')
}

/** Есть ли у человека нерешённая заявка на форс-мажор за последние сутки. */
export async function hasOpenForceMajeure(userId, now = new Date()) {
  const open = await prisma.botNotice.findMany({
    where: { key: { startsWith: `fm-open:${userId}:` }, sentAt: { gt: new Date(now.getTime() - 24 * 60 * 60 * 1000) } },
    select: { key: true },
  })
  const decisions = open.map(({ key }) => `fm:${key.split(':')[2]}`)
  return (await unsentKeys(decisions)).size > 0
}

/** Решение Яна по форс-мажору. Возвращает текст для его сообщения. */
export async function decideForceMajeure(owner, messageId, approve, now = new Date()) {
  if (owner?.role !== 'admin') return { text: null, toast: 'Это решает владелец' }
  const message = await prisma.botMessage.findUnique({ where: { id: messageId }, include: { user: { select: { id: true, name: true, active: true } } } })
  // Заявка — только то сообщение человека, которое бот передал Яну.
  if (!message?.user || !['in', 'reply'].includes(message.direction) || !(await hasNotice(`fm-open:${message.user.id}:${message.id}`))) {
    return { text: 'Заявка не найдена.' }
  }
  if (!(await claimNotice(`fm:${messageId}`))) return { text: null, toast: 'Уже решено' }
  const user = message.user
  if (!approve) {
    await logEvent(user.id, 'fm_decision', { at: now, data: { approved: false, by: owner.name } })
    await tell(user.id, 'Ян не подтвердил форс-мажор.\nЕсли что-то изменилось, напиши ему.')
    return { text: `<b>Форс-мажор не подтверждён</b>\n${nameOf(user)}\n<i>${escapeHtml(message.text.slice(0, 300))}</i>`, rejectedUserId: user.id }
  }
  let until = parseUntil(message.text, message.createdAt) ?? endOfDay(message.createdAt)
  if (until <= now) until = endOfDay(now)
  // Уже стоит форс-мажор дольше (Ян поставил больничный до пятницы) — не
  // укорачиваем его.
  const current = await activeAway(user.id, now)
  if (current?.kind === 'force_majeure' && current.until >= until) {
    await prisma.botCheckinAnswer.updateMany({
      where: { userId: user.id, status: 'skipped', answer: FM_PENDING },
      data: { answer: 'форс-мажор подтверждён' },
    })
    await logEvent(user.id, 'fm_decision', { at: now, data: { approved: true, by: owner.name, until: current.until.toISOString() } })
    return { text: `<b>Форс-мажор уже стоит до ${at(current.until, now)}</b>\n${nameOf(user)}\n<i>${escapeHtml(message.text.slice(0, 300))}</i>\n\nОставил как есть` }
  }
  try {
    await prisma.$transaction(async (tx) => {
      await lockUser(tx, user.id)
      await tx.motivationAway.updateMany({ where: { userId: user.id, endedAt: null, until: { gt: now } }, data: { endedAt: now } })
      await tx.motivationAway.create({
        data: {
          userId: user.id, from: message.createdAt < now ? message.createdAt : now, until,
          reason: message.text.slice(0, 200), kind: 'force_majeure', source: 'bot', createdById: owner.id,
        },
      })
    })
  } catch (e) {
    // Метка не встала — решение не засчитано, кнопку можно нажать снова.
    await releaseNotice(`fm:${messageId}`)
    throw e
  }
  // Штраф за чек-ин, отложенный из-за этой заявки, больше не ждёт: Ян
  // подтвердил — его не будет.
  await prisma.botCheckinAnswer.updateMany({
    where: { userId: user.id, status: 'skipped', answer: FM_PENDING },
    data: { answer: 'форс-мажор подтверждён' },
  })
  await logEvent(user.id, 'fm_decision', { at: now, data: { approved: true, by: owner.name, until: until.toISOString() } })
  await tell(user.id, `Ян подтвердил форс-мажор до ${at(until, now)}.\nДо этого времени я тебя не дёргаю.`)
  return { text: `<b>Форс-мажор подтверждён до ${at(until, now)}</b>\n${nameOf(user)}\n<i>${escapeHtml(message.text.slice(0, 300))}</i>\n\nМетка стоит в CRM` }
}

/**
 * Раз в минуту: перед концом отлучки спросить «ты на месте?», а кто
 * пропал после срока — сообщить Яну (один раз).
 */
export async function tickBreaks(now = new Date()) {
  // Ночью и в выходные не спрашиваем и Яну не пишем: это уже не рабочее время.
  if (isQuietHour(now) || !isWorkday(mskDayKey(now))) return
  const soon = await prisma.motivationAway.findMany({
    where: { kind: 'break', endedAt: null, returnedAt: null, returnAskedAt: null, until: { gt: now, lte: new Date(now.getTime() + 10 * 60000) } },
    include: { user: { select: { id: true, name: true, active: true } } },
  })
  for (const away of soon) {
    const total = minutesBetween(away.from, away.until)
    // Короткая отлучка — спрашиваем за 5 минут (а совсем короткую — на
    // середине), а не сразу после ухода.
    const askAt = total <= 20 ? Math.min(5, Math.floor(total / 2)) : 10
    if (minutesBetween(now, away.until) > askAt) continue
    const claimed = await prisma.motivationAway.updateMany({ where: { id: away.id, returnAskedAt: null }, data: { returnAskedAt: now } })
    if (!claimed.count || !away.user.active) continue
    const res = await tell(away.userId, `В ${hm(away.until)} заканчивается отлучка. Ты на месте?`, { buttons: RETURN_BUTTONS(away.id) })
    // Сбой временный — спросим на следующем проходе.
    if (!res.ok && res.retry) await prisma.motivationAway.updateMany({ where: { id: away.id, returnAskedAt: now }, data: { returnAskedAt: null } })
  }

  const silent = await prisma.motivationAway.findMany({
    where: {
      kind: 'break', endedAt: null, returnedAt: null,
      until: { lte: new Date(now.getTime() - SILENT_AFTER_MIN * 60000), gt: new Date(now.getTime() - 6 * 60 * 60 * 1000) },
    },
    include: { user: { select: { id: true, name: true, active: true } } },
  })
  for (const away of silent) {
    if (!away.user.active) continue
    const res = await sendOnce(`away-silent:${away.id}:${away.until.getTime()}`, () =>
      tellOwners(`<b>Нет ответа после отлучки</b>\n${nameOf(away.user)}\nОтлучка закончилась в ${hm(away.until)}, прошло ${duration(minutesBetween(away.until, now))}`))
    if (res.skipped) continue
    await tell(away.userId, `Отлучка закончилась в ${hm(away.until)}. Ты на месте?`, { buttons: RETURN_BUTTONS(away.id) })
  }
}

