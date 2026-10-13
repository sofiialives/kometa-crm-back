import { prisma } from '../../config/prisma.js'
import { parseUntil } from '../parse.js'
import { escapeHtml } from '../telegram.js'
import { at, duration, endOfDay, hm, minutesBetween } from './format.js'
import { claimNotice, nameOf, tell, tellOwners } from './notify.js'
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
const SILENT_AFTER_MIN = 15
const lockUser = (tx, userId) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}))`

export const MENU = [
  [{ text: '🚶 Отхожу', data: 'm:away' }, { text: '✅ Я на месте', data: 'm:back' }],
  [{ text: '⚠️ Форс-мажор', data: 'm:fm' }],
]

const BREAK_BUTTONS = (prefix) => [[
  { text: '15 мин', data: `${prefix}:15` },
  { text: '30 мин', data: `${prefix}:30` },
  { text: '1 час', data: `${prefix}:60` },
  { text: '2 часа', data: `${prefix}:120` },
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
 * кнопками. Уже отошёл — это продление. Действует форс-мажор — отлучка не
 * нужна, он и так прикрывает.
 */
export async function startBreak(user, { until = null, note = null } = {}, now = new Date()) {
  const timeGiven = Boolean(until)
  const end = until ?? new Date(now.getTime() + DEFAULT_BREAK_MIN * 60000)

  const result = await prisma.$transaction(async (tx) => {
    await lockUser(tx, user.id)
    const current = await activeAway(user.id, now, tx)
    if (current?.kind === 'force_majeure') return { type: 'covered', away: current }
    const open = current?.kind === 'break' ? current : await openBreak(user.id, now, tx)
    if (open) {
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
  const left = duration(minutesBetween(now, away.until))
  if (result.type === 'covered') {
    await tell(user.id, `У тебя и так отмечен форс-мажор до ${at(away.until, now)} — отдыхай, я не дёргаю.`)
    return result
  }
  if (result.type === 'started') {
    if (timeGiven) {
      await tell(user.id, `Понял, жду к <b>${hm(away.until)}</b> (${left}). Перед концом спрошу, на месте ли ты.`)
    } else {
      state.expect(user.id, 'break_time', { awayId: away.id })
      await tell(user.id, 'На сколько отходишь? Нажми кнопку или напиши время, например «до 16:30». Не ответишь — считаю час.', { buttons: BREAK_BUTTONS('aw') })
    }
    await tellOwners(`🚶 ${nameOf(user)}: отлучка до <b>${hm(away.until)}</b> (${left})${timeGiven ? '' : ', время не назвали — считаю час'}.${note ? `\n«${note.slice(0, 200)}»` : ''}`)
    return result
  }
  if (result.type === 'clarified') {
    await tell(user.id, `Принято: жду к <b>${hm(away.until)}</b>.`)
    await tellOwners(`🕑 ${nameOf(user)}: вернётся к <b>${hm(away.until)}</b> (уточнение).`)
    return result
  }
  await tell(user.id, `Хорошо, жду к <b>${hm(away.until)}</b>.`)
  await tellOwners(`⏳ ${nameOf(user)}: продлевает отлучку до <b>${hm(away.until)}</b> (уже ${away.extensions}-й раз).`)
  return result
}

/** Кнопка «15 мин / 30 мин…» под вопросом «на сколько?» или «до скольки задерживаешься?». */
export function setBreakMinutes(user, minutes, now = new Date()) {
  state.clear(user.id)
  return startBreak(user, { until: new Date(now.getTime() + minutes * 60000) }, now)
}

/** «Вернулся», «я на месте». */
export async function comeBack(user, now = new Date()) {
  state.clear(user.id)
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
    await tell(user.id, 'Отметил: ты на месте 👍')
    return null
  }
  const gone = duration(minutesBetween(away.from, now))
  const late = minutesBetween(away.until, now)
  await tell(user.id, `С возвращением! Тебя не было ${gone}.`)
  await tellOwners(`✅ ${nameOf(user)} на месте. Не было ${gone}${late > 1 ? `, опоздание ${duration(late)} (ждали к ${hm(away.until)})` : ''}.`)
  return away
}

/** «Задерживаюсь» с отлучкой или без. Без времени — спрашиваем, до скольки. */
export async function runningLate(user, { until = null, text = '' } = {}, now = new Date()) {
  const open = await openBreak(user.id, now)
  if (open) {
    if (until) return startBreak(user, { until }, now)
    state.expect(user.id, 'break_time', { awayId: open.id })
    await tell(user.id, 'До скольки задерживаешься? Нажми кнопку или напиши время.', { buttons: BREAK_BUTTONS('aw') })
    return null
  }
  await tell(user.id, 'Понял, передал Яну.')
  await tellOwners(`⏳ ${nameOf(user)}: задержка${until ? ` до <b>${hm(until)}</b>` : ''} — «${escapeHtml(text.slice(0, 300))}»`)
  return null
}

/**
 * Форс-мажор: человек описывает, бот передаёт Яну с кнопками. Пока Ян не
 * решил, заявка висит в BotNotice «fm-open:…», и чек-ин человека не штрафует.
 */
export async function reportForceMajeure(user, text, message, now = new Date()) {
  state.clear(user.id)
  if (!message) return
  await claimNotice(`fm-open:${user.id}:${message.id}`)
  const until = parseUntil(text, now) ?? endOfDay(now)
  await tell(user.id, 'Передал Яну. Как подтвердит — поставлю метку, и до её конца я тебя не трогаю. Выздоравливай / держись 🙏')
  await tellOwners(
    `⚠️ <b>${nameOf(user)}: форс-мажор</b>\n«${escapeHtml(text.slice(0, 500))}»\n\nМетка будет до ${at(until, now)}.`,
    { buttons: [[{ text: 'Подтвердить', data: `fm:y:${message.id}` }, { text: 'Не подтверждать', data: `fm:n:${message.id}` }]] },
  )
}

/** Есть ли у человека нерешённая заявка на форс-мажор за последние сутки. */
export async function hasOpenForceMajeure(userId, now = new Date()) {
  const open = await prisma.botNotice.findMany({
    where: { key: { startsWith: `fm-open:${userId}:` }, sentAt: { gt: new Date(now.getTime() - 24 * 60 * 60 * 1000) } },
    select: { key: true },
  })
  for (const { key } of open) {
    const messageId = key.split(':')[2]
    if (!(await prisma.botNotice.findUnique({ where: { key: `fm:${messageId}` } }))) return true
  }
  return false
}

/** Решение Яна по форс-мажору. Возвращает текст для его сообщения. */
export async function decideForceMajeure(owner, messageId, approve, now = new Date()) {
  const message = await prisma.botMessage.findUnique({ where: { id: messageId }, include: { user: { select: { id: true, name: true, active: true } } } })
  if (!message?.user) return { text: 'Заявка не найдена.' }
  if (!(await claimNotice(`fm:${messageId}`))) return { text: null, toast: 'Уже решено' }
  const user = message.user
  if (!approve) {
    await tell(user.id, 'Ян не подтвердил форс-мажор. Если что-то изменилось — напиши ему.')
    return { text: `❌ ${nameOf(user)}: форс-мажор не подтверждён.\n«${escapeHtml(message.text.slice(0, 300))}»` }
  }
  let until = parseUntil(message.text, message.createdAt) ?? endOfDay(message.createdAt)
  if (until <= now) until = endOfDay(now)
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
  await tell(user.id, `Ян подтвердил форс-мажор до ${at(until, now)}. До этого времени я тебя не дёргаю.`)
  return { text: `✅ ${nameOf(user)}: форс-мажор до ${at(until, now)} — метка стоит в CRM.\n«${escapeHtml(message.text.slice(0, 300))}»` }
}

/**
 * Раз в минуту: перед концом отлучки спросить «ты на месте?», а кто
 * пропал после срока — сообщить Яну (один раз).
 */
export async function tickBreaks(now = new Date()) {
  const soon = await prisma.motivationAway.findMany({
    where: { kind: 'break', endedAt: null, returnedAt: null, returnAskedAt: null, until: { gt: now, lte: new Date(now.getTime() + 10 * 60000) } },
    include: { user: { select: { id: true, name: true, active: true } } },
  })
  for (const away of soon) {
    const total = minutesBetween(away.from, away.until)
    // Короткая отлучка — спрашиваем за 5 минут, а не через 5 минут после ухода.
    const askAt = total <= 20 ? 5 : 10
    if (minutesBetween(now, away.until) > askAt) continue
    const claimed = await prisma.motivationAway.updateMany({ where: { id: away.id, returnAskedAt: null }, data: { returnAskedAt: now } })
    if (!claimed.count || !away.user.active) continue
    await tell(away.userId, `В ${hm(away.until)} заканчивается отлучка. Ты на месте?`, {
      buttons: [[{ text: '✅ Да, на месте', data: `rt:y:${away.id}` }, { text: '⏳ Задерживаюсь', data: `rt:l:${away.id}` }]],
    })
  }

  const silent = await prisma.motivationAway.findMany({
    where: {
      kind: 'break', endedAt: null, returnedAt: null,
      until: { lte: new Date(now.getTime() - SILENT_AFTER_MIN * 60000), gt: new Date(now.getTime() - 6 * 60 * 60 * 1000) },
    },
    include: { user: { select: { id: true, name: true, active: true } } },
  })
  for (const away of silent) {
    if (!away.user.active || !(await claimNotice(`away-silent:${away.id}:${away.until.getTime()}`))) continue
    await tell(away.userId, `Отлучка закончилась в ${hm(away.until)}. Ты на месте?`, {
      buttons: [[{ text: '✅ Да, на месте', data: `rt:y:${away.id}` }, { text: '⏳ Задерживаюсь', data: `rt:l:${away.id}` }]],
    })
    await tellOwners(`❓ ${nameOf(away.user)}: отлучка кончилась в <b>${hm(away.until)}</b>, ответа нет (прошло ${duration(minutesBetween(away.until, now))}).`)
  }
}

