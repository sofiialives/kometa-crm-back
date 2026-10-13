import { prisma } from '../../config/prisma.js'
import { escapeHtml } from '../telegram.js'
import { BANK_REASON_LABELS } from '../../services/motivation/bank.service.js'
import { getSettingsRow } from '../../services/motivation/profiles.js'
import { approveReview, rejectReview } from '../../services/motivation/review.service.js'
import { points, short } from './format.js'
import { claimNotice, crmButton, hasNotice, nameOf, ownerIds, row, tell } from './notify.js'

/**
 * Лента: что изменилось в CRM — тому, кого касается.
 *
 * Сотруднику — пополнения и списания банка, начисленные и снятые баллы
 * (если владелец не выключил это в настройках). Яну — новые заявки «На
 * проверке» с кнопками «Начислить» / «Не начислять» и новые работы в
 * Иерархии («пополнить банк?»).
 *
 * Не событиями из сервисов, а проходом раз в минуту по журналам: так
 * ничего не теряется при перезапуске и не нужно трогать каждый сервис.
 * Ночью (с 21:00 до 9:00) не пишем — всё накопленное уйдёт утром. Каждая
 * запись уходит один раз (ключ в BotNotice). При первом запуске прошлое не
 * рассылаем — отметка ставится на «сейчас».
 */

const WATERMARK = 'feed:watermark'
const OWNER_INIT = 'feed:owner-init'
const OVERLAP_MS = 5 * 60000
const QUIET_FROM_H = 21
const QUIET_TO_H = 9

export function isQuietHour(now = new Date()) {
  const h = (new Date(now).getUTCHours() + 3) % 24
  return h >= QUIET_FROM_H || h < QUIET_TO_H
}

/**
 * Отметка «до какого момента лента разобрана». Двигается по времени самих
 * записей, а не по часам сервера: часы базы и приложения могут чуть
 * расходиться, и запись на стыке потерялась бы. При первом запуске —
 * самая свежая запись: прошлое не рассылаем.
 */
async function readWatermark() {
  const row = await prisma.botNotice.findUnique({ where: { key: WATERMARK } })
  if (row) return row.sentAt
  const [bank, event] = await Promise.all([
    prisma.motivationBankEntry.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
    prisma.motivationEvent.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
  ])
  const start = new Date(Math.max(bank?.createdAt?.getTime() ?? 0, event?.createdAt?.getTime() ?? 0, Date.now()))
  await prisma.botNotice.create({ data: { key: WATERMARK, sentAt: start } }).catch(() => {})
  return null
}

const SPECIAL = {
  call_missed: (p) => `Тебя не было на вечернем звонке — ${points(p)}. Ждём на следующем, в 19:00 🙌`,
  call_attended: (p) => `Спасибо за вечерний звонок — ${points(p)} 👍`,
  checkin_missed: (p) => `На внезапный чек-ин не было ответа — ${points(p)}. Если отходишь, просто напиши мне «отхожу на 30 минут» — тогда не спрашиваю.`,
}

function eventLine(e) {
  const special = SPECIAL[e.eventType?.systemKey]
  if (special) return special(e.prizePoints)
  const icon = e.prizePoints >= 0 ? '⭐' : '🔻'
  const what = e.taskTitle ? `${e.title}: «${short(e.taskTitle, 80)}»` : e.title
  return `${icon} ${points(e.prizePoints)} — ${escapeHtml(what)}${e.comment ? `\n<i>${escapeHtml(short(e.comment, 160))}</i>` : ''}`
}

function bankLine(b) {
  const dollars = (b.amountCents / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 })
  if (b.kind === 'start') return `💰 Новый месяц: в банке $${dollars}`
  if (b.kind === 'write_off') return `💸 Из банка списано $${dollars}${b.comment ? ` — ${escapeHtml(short(b.comment, 120))}` : ''}`
  const why = [BANK_REASON_LABELS[b.reason], b.clientName && `«${b.clientName}»`].filter(Boolean).join(' ')
  return `💰 Банк пополнен на $${dollars}${why ? ` — ${escapeHtml(why)}` : ''}`
}

/** Сотрудникам: банк и баллы. Возвращает новую отметку. */
async function employeeFeed(since, settings) {
  const from = new Date(since.getTime() - OVERLAP_MS)
  let mark = since.getTime()
  const seen = (...dates) => { for (const d of dates) if (d) mark = Math.max(mark, d.getTime()) }
  const byUser = new Map()
  const push = (userId, line) => byUser.set(userId, [...(byUser.get(userId) ?? []), line])

  if (settings.notifyBank) {
    const entries = await prisma.motivationBankEntry.findMany({
      where: { createdAt: { gt: from } },
      orderBy: { createdAt: 'asc' },
    })
    for (const b of entries) {
      seen(b.createdAt)
      if (await claimNotice(`bank:${b.id}`)) push(b.userId, bankLine(b))
    }
  }
  if (settings.notifyPoints) {
    const events = await prisma.motivationEvent.findMany({
      where: { OR: [{ createdAt: { gt: from } }, { cancelledAt: { gt: from } }] },
      include: { eventType: { select: { systemKey: true } } },
      orderBy: { createdAt: 'asc' },
    })
    for (const e of events) {
      seen(e.createdAt, e.cancelledAt)
      if (e.cancelledAt) {
        // Отмену сообщаем, только если о самих баллах человек уже знал.
        if (await hasNotice(`event:${e.id}`) && (await claimNotice(`event-cancel:${e.id}`))) {
          push(e.userId, `↩️ Отменено: ${points(e.prizePoints)} — ${escapeHtml(short(e.taskTitle ? `${e.title}: «${e.taskTitle}»` : e.title, 100))}${e.cancelReason ? `\n<i>${escapeHtml(short(e.cancelReason, 160))}</i>` : ''}`)
        } else {
          await claimNotice(`event:${e.id}`)
        }
        continue
      }
      if (await claimNotice(`event:${e.id}`)) push(e.userId, eventLine(e))
    }
  }
  for (const [userId, lines] of byUser) {
    await tell(userId, lines.join('\n\n'), { buttons: [row(crmButton('Моя мотивация', '/motivation'))].filter((r) => r.length) })
  }
  return new Date(mark)
}

const COMPLEXITY = { low: 'простая', medium: 'средняя', high: 'сложная' }
const RULE_TEXT = {
  task_on_time: 'Задача из Иерархии закрыта в срок',
  personal_task_on_time: 'Личная задача закрыта в срок',
  task_overdue: 'Просрочена задача из Иерархии',
  personal_task_overdue: 'Просрочена личная задача',
}

export function reviewText(r) {
  const lines = [
    `🧾 <b>На проверке: ${nameOf(r.user)}</b>`,
    `${RULE_TEXT[r.rule] || escapeHtml(r.title)}${r.taskTitle ? `\n«${escapeHtml(short(r.taskTitle, 140))}»` : ''}`,
  ]
  const facts = []
  if (r.complexity) facts.push(`сложность: ${COMPLEXITY[r.complexity]}`)
  if (r.nights?.length > 1) facts.push(`просрочено ночей: ${r.nights.length}`)
  facts.push(`подсказка: <b>${points(r.prizePoints)}</b>`)
  lines.push(facts.join(' · '))
  return lines.join('\n')
}

export function reviewButtons(r) {
  const minus = r.prizePoints < 0
  return [[
    { text: `${minus ? 'Снять' : 'Начислить'} ${points(r.prizePoints)}`, data: `rv:a:${r.id}:${r.prizePoints}` },
    { text: minus ? 'Не снимать' : 'Не начислять', data: `rv:r:${r.id}` },
  ]]
}

/**
 * Яну: новые заявки и новые работы. При первом запуске всё, что уже лежит
 * в очереди, считается отправленным — разбирать старое Ян будет во вкладке.
 */
async function ownerFeed() {
  const owners = await ownerIds()
  if (!owners.length) return
  const [reviews, hints] = await Promise.all([
    prisma.motivationReview.findMany({
      where: { status: 'pending' },
      include: { user: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'asc' },
      take: 300,
    }),
    prisma.motivationWorkHint.findMany({ where: { status: 'pending' }, orderBy: { createdAt: 'asc' }, take: 100 }),
  ])
  if (await claimNotice(OWNER_INIT)) {
    for (const r of reviews) await claimNotice(`review:${r.id}`)
    for (const h of hints) await claimNotice(`hint:${h.id}`)
    return
  }

  for (const r of reviews) {
    if (!(await claimNotice(`review:${r.id}`))) continue
    for (const id of owners) await tell(id, reviewText(r), { buttons: reviewButtons(r) })
  }
  for (const h of hints) {
    if (!(await claimNotice(`hint:${h.id}`))) continue
    const text = `🆕 <b>Новая работа в Иерархии</b>\n«${escapeHtml(short(h.workTitle, 140))}»${h.clientName ? `\nКлиент: ${escapeHtml(h.clientName)}` : ''}${h.departmentName ? ` · ${escapeHtml(h.departmentName)}` : ''}\n\nПополнить банк исполнителям?`
    for (const id of owners) await tell(id, text, { buttons: [row(crmButton('Открыть «На проверке»', '/motivation?section=review'))].filter((r) => r.length) })
  }
}

/** Раз в минуту. */
export async function tickFeed(now = new Date()) {
  if (isQuietHour(now)) return
  const since = await readWatermark()
  if (since) {
    const mark = await employeeFeed(since, await getSettingsRow())
    if (mark > since) await prisma.botNotice.update({ where: { key: WATERMARK }, data: { sentAt: mark } })
  }
  await ownerFeed()
}

/** Нажатие «Начислить» / «Не начислять» у Яна. Возвращает новый текст сообщения. */
export async function decideReview(owner, data, now = new Date()) {
  const [, action, id, seen] = data.split(':')
  const load = () => prisma.motivationReview.findUnique({ where: { id }, include: { user: { select: { id: true, name: true } } } })
  try {
    if (action === 'a') {
      const r = await approveReview(owner, id, { seenPrizePoints: Number(seen) }, now)
      return { text: `${reviewText({ ...(await load()), prizePoints: r.awarded?.prizePoints ?? r.prizePoints })}\n\n✅ ${r.prizePoints < 0 ? 'Снято' : 'Начислено'}` }
    }
    await rejectReview(owner, id, {}, now)
    const r = await load()
    return { text: `${reviewText(r)}\n\n❌ ${r.prizePoints < 0 ? 'Не снимать' : 'Не начислять'}` }
  } catch (e) {
    const r = await load()
    if (!r) return { text: 'Заявка не найдена — возможно, задачу удалили.' }
    // Пока Ян читал, ночь добавила штраф — показываем новое число и новые кнопки.
    if (e.status === 409 && r.status === 'pending') {
      return { text: `${reviewText(r)}\n\n<i>Заявка обновилась — проверьте новое число.</i>`, buttons: reviewButtons(r) }
    }
    const done = { approved: '✅ Уже начислено', rejected: '❌ Уже отклонено', withdrawn: '↩️ Заявку сняла система: задачу вернули или удалили' }[r.status]
    return { text: `${reviewText(r)}\n\n${done || `Не получилось: ${e.message}`}` }
  }
}

