import { prisma } from '../../config/prisma.js'
import { escapeHtml } from '../telegram.js'
import { BANK_REASON_LABELS } from '../../services/motivation/bank.service.js'
import { getSettingsRow } from '../../services/motivation/profiles.js'
import { approveReview, rejectReview } from '../../services/motivation/review.service.js'
import { isQuietHour } from '../plan.js'
import { points, short } from './format.js'
import { aiRateReview } from '../ai/agent.js'
import { claimNotice, crmButton, nameOf, ownerIds, releaseNotice, row, sendOnce, tell, tellOwners, unsentKeys } from './notify.js'

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
  // Записи последних минут до запуска тоже считаем старыми: проход берёт
  // запас в 5 минут назад и иначе разослал бы их.
  const recent = { gt: new Date(start.getTime() - 2 * OVERLAP_MS) }
  const [entries, events] = await Promise.all([
    prisma.motivationBankEntry.findMany({ where: { createdAt: recent }, select: { id: true } }),
    prisma.motivationEvent.findMany({ where: { OR: [{ createdAt: recent }, { cancelledAt: recent }] }, select: { id: true } }),
  ])
  await prisma.botNotice.createMany({
    data: [...entries.map((b) => ({ key: `bank:${b.id}` })), ...events.flatMap((e) => [{ key: `event:${e.id}` }, { key: `event-cancel:${e.id}` }])],
    skipDuplicates: true,
  })
  await prisma.botNotice.create({ data: { key: WATERMARK, sentAt: start } }).catch(() => {})
  return null
}

const SPECIAL = {
  call_missed: (p) => `Тебя не было на вечернем звонке, ${points(p)}.\nЖдём на следующем.`,
  call_attended: (p) => `Спасибо за вечерний звонок, ${points(p)}.`,
  checkin_missed: (p) => `На внезапный чек-ин не было ответа, ${points(p)}.\nЕсли отходишь, просто напиши мне <i>отхожу на 30 минут</i>, и я не буду спрашивать.`,
}

export function eventLine(e) {
  const special = SPECIAL[e.eventType?.systemKey]
  if (special) return special(e.prizePoints)
  if (e.prizePoints === 0) {
    // Корректировка только уровня работы — без «0 баллов».
    if (!e.levelPoints) return null
    return `${e.levelPoints > 0 ? '+' : '−'}${Math.abs(e.levelPoints)} к уровню работы\n${escapeHtml(e.title)}`
  }
  const what = e.taskTitle ? `${e.title} «${short(e.taskTitle, 80)}»` : e.title
  return `${points(e.prizePoints)}\n${escapeHtml(what)}${e.comment ? `\n<i>${escapeHtml(short(e.comment, 160))}</i>` : ''}`
}

export function bankLine(b) {
  // Списание лежит в журнале с минусом — в тексте «списано» минус лишний.
  const dollars = (Math.abs(b.amountCents) / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 })
  if (b.kind === 'start') return `Новый месяц, в банке $${dollars}`
  if (b.kind === 'write_off') return `Из банка списано $${dollars}${b.comment ? `\n${escapeHtml(short(b.comment, 120))}` : ''}`
  const why = [BANK_REASON_LABELS[b.reason], b.clientName && `«${b.clientName}»`].filter(Boolean).join(' ')
  return `Банк пополнен на $${dollars}${why ? `\n${escapeHtml(why)}` : ''}`
}

/**
 * Сотрудникам: банк и баллы. Возвращает новую отметку; если что-то не ушло
 * из-за временного сбоя — прежнюю, чтобы следующий проход взял это снова.
 */
async function employeeFeed(since, settings) {
  const from = new Date(since.getTime() - OVERLAP_MS)
  let mark = since.getTime()
  const seen = (...dates) => { for (const d of dates) if (d) mark = Math.max(mark, d.getTime()) }
  const byUser = new Map()
  const push = (userId, key, line) => {
    const item = byUser.get(userId) ?? { keys: [], lines: [] }
    item.keys.push(key)
    if (line) item.lines.push(line)
    byUser.set(userId, item)
  }

  // Читаем оба журнала всегда: отметка должна идти вперёд и по тому, о чём
  // сейчас не сообщаем, — иначе после включения пришло бы накопленное.
  const [allEntries, allEvents] = await Promise.all([
    prisma.motivationBankEntry.findMany({ where: { createdAt: { gt: from } }, orderBy: { createdAt: 'asc' } }),
    prisma.motivationEvent.findMany({
      where: { OR: [{ createdAt: { gt: from } }, { cancelledAt: { gt: from } }] },
      include: { eventType: { select: { systemKey: true } } },
      orderBy: { createdAt: 'asc' },
    }),
  ])
  for (const b of allEntries) seen(b.createdAt)
  for (const e of allEvents) seen(e.createdAt, e.cancelledAt)
  const entries = settings.notifyBank ? allEntries : []
  const events = settings.notifyPoints ? allEvents : []
  const unsent = await unsentKeys([
    ...entries.map((b) => `bank:${b.id}`),
    ...events.flatMap((e) => [`event:${e.id}`, `event-cancel:${e.id}`]),
  ])

  for (const b of entries) {
    if (unsent.has(`bank:${b.id}`)) push(b.userId, `bank:${b.id}`, bankLine(b))
  }
  for (const e of events) {
    const told = !unsent.has(`event:${e.id}`)
    if (e.cancelledAt) {
      // Отмену сообщаем, только если о самих баллах человек уже знал;
      // не знал — молча отмечаем, чтобы не сообщить о них позже.
      // Пустую корректировку человек не видел — и отмену тоже не сообщаем.
      if (told && e.prizePoints === 0 && !e.levelPoints) await claimNotice(`event-cancel:${e.id}`)
      else if (told && unsent.has(`event-cancel:${e.id}`)) {
        const what = e.prizePoints === 0 ? `${e.levelPoints > 0 ? '+' : '−'}${Math.abs(e.levelPoints)} к уровню работы` : points(e.prizePoints)
        push(e.userId, `event-cancel:${e.id}`, `Отменено ${what}\n${escapeHtml(short(e.taskTitle ? `${e.title} «${e.taskTitle}»` : e.title, 100))}${e.cancelReason ? `\n<i>${escapeHtml(short(e.cancelReason, 160))}</i>` : ''}`)
      } else if (!told) await claimNotice(`event:${e.id}`)
      continue
    }
    if (!told) push(e.userId, `event:${e.id}`, eventLine(e))
  }
  for (const item of byUser.values()) item.lines = item.lines.filter(Boolean)
  for (const [userId, item] of byUser) {
    // Нечего сказать (корректировка без баллов) — отметить и не писать.
    if (!item.lines.length) {
      for (const key of item.keys) await claimNotice(key)
      byUser.delete(userId)
    }
  }

  let failed = false
  for (const [userId, { keys, lines }] of byUser) {
    const claimed = []
    for (const key of keys) if (await claimNotice(key)) claimed.push(key)
    if (!claimed.length) continue
    const res = await tell(userId, lines.join('\n\n'), { buttons: [row(crmButton('Моя мотивация', '/motivation'))].filter((r) => r.length) })
    if (!res.ok && res.retry) {
      failed = true
      for (const key of claimed) await releaseNotice(key)
    }
  }
  return failed ? since : new Date(mark)
}

const COMPLEXITY = { low: 'простая', medium: 'средняя', high: 'сложная' }
const RULE_TEXT = {
  task_on_time: 'Задача из Иерархии закрыта в срок',
  personal_task_on_time: 'Личная задача закрыта в срок',
  task_overdue: 'Просрочена задача из Иерархии',
  personal_task_overdue: 'Просрочена личная задача',
  task_not_started: 'Задача не начата вовремя',
}

export function reviewText(r) {
  const lines = [
    `<b>На проверке</b>\n${nameOf(r.user)}`,
    `${RULE_TEXT[r.rule] || escapeHtml(r.title)}${r.taskTitle ? `\n«${escapeHtml(short(r.taskTitle, 140))}»` : ''}`,
  ]
  const facts = []
  if (r.complexity) facts.push(`сложность ${COMPLEXITY[r.complexity]}`)
  if (r.nights?.length > 1) facts.push(`просрочено ночей ${r.nights.length}`)
  facts.push(`предлагаю <b>${points(r.prizePoints)}</b>`)
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
    // Свежие сначала: при длинной очереди новые заявки не должны теряться
    // за старыми. Отправляем потом по порядку.
    prisma.motivationReview.findMany({
      where: { status: 'pending' },
      include: { user: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 300,
    }).then((rows) => rows.reverse()),
    prisma.motivationWorkHint.findMany({ where: { status: 'pending' }, orderBy: { createdAt: 'desc' }, take: 100 }).then((rows) => rows.reverse()),
  ])
  if (await claimNotice(OWNER_INIT)) {
    await prisma.botNotice.createMany({
      data: [...reviews.map((r) => ({ key: `review:${r.id}` })), ...hints.map((h) => ({ key: `hint:${h.id}` }))],
      skipDuplicates: true,
    })
    return
  }
  const unsent = await unsentKeys([...reviews.map((r) => `review:${r.id}`), ...hints.map((h) => `hint:${h.id}`)])

  // Оценок ИИ за проход — не больше трёх: рассылка заявок не должна ждать ИИ.
  let aiRatings = 3
  for (const r of reviews) {
    if (!unsent.has(`review:${r.id}`)) continue
    // Сложность личной задачи — по смыслу, если ИИ включён; иначе по длине описания.
    // Счётчик — только на личные задачи: остальные ИИ не оценивает.
    const complexity = r.complexity && aiRatings-- > 0 ? await aiRateReview(r) : r.complexity
    const card = { ...r, complexity }
    await sendOnce(`review:${r.id}`, () => tellOwners(reviewText(card), { buttons: reviewButtons(card) }))
  }
  for (const h of hints) {
    if (!unsent.has(`hint:${h.id}`)) continue
    const text = `<b>Новая работа в Иерархии</b>\n«${escapeHtml(short(h.workTitle, 140))}»${h.clientName ? `\nКлиент ${escapeHtml(h.clientName)}` : ''}${h.departmentName ? ` · ${escapeHtml(h.departmentName)}` : ''}\n\nПополнить банк исполнителям?`
    await sendOnce(`hint:${h.id}`, () => tellOwners(text, { buttons: [row(crmButton('Открыть «На проверке»', '/motivation?section=review'))].filter((r) => r.length) }))
  }
}

/** Раз в минуту. */
export async function tickFeed(now = new Date()) {
  // Отметку ставим и ночью: выкатили вечером — утром не придёт ночное старьё.
  const since = await readWatermark()
  if (isQuietHour(now)) return
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
      return { text: `${reviewText({ ...(await load()), prizePoints: r.awarded?.prizePoints ?? r.prizePoints })}\n\n<b>${r.prizePoints < 0 ? 'Снято' : 'Начислено'}</b>` }
    }
    await rejectReview(owner, id, {}, now)
    const r = await load()
    return { text: `${reviewText(r)}\n\n<b>${r.prizePoints < 0 ? 'Не снимать' : 'Не начислять'}</b>` }
  } catch (e) {
    const r = await load()
    if (!r) return { text: 'Заявка не найдена, возможно, задачу удалили.' }
    // Пока Ян читал, ночь добавила штраф — показываем новое число и новые кнопки.
    if (e.status === 409 && r.status === 'pending') {
      return { text: `${reviewText(r)}\n\n<i>Заявка обновилась, проверьте новое число.</i>`, buttons: reviewButtons(r) }
    }
    const done = { approved: 'Уже начислено', rejected: 'Уже отклонено', withdrawn: 'Заявку сняла система, задачу вернули или удалили' }[r.status]
    if (!done) console.error('[агент] решение по заявке:', e.message)
    return { text: `${reviewText(r)}\n\n${done || (e.status ? `Не получилось. ${escapeHtml(e.message)}` : 'Не получилось, решите во вкладке «На проверке».')}` }
  }
}

