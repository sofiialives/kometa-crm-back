import { prisma } from '../../config/prisma.js'
import { isParticipant } from '../../services/motivation/access.js'
import { escapeHtml, sendChatAction } from '../telegram.js'
import { nameOf, tellChat, tellOwners } from '../agent/notify.js'
import { activeTarget, countReply, linkMessages, ROUND_REPLIES_MAX } from '../agent/rounds.js'
import { isQuietHour, mskDayKey } from '../plan.js'
import { aiEnabled, askJson } from './client.js'
import { labelOf, staffBrief, teamBrief } from './context.js'
import { preflight, runAgent } from './engine.js'
import { cut, MAX_INPUT_CHARS, MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS_TEAM } from './limits.js'
import { fileBlocks } from './media.js'
import { recentRows, toMessages } from './memory.js'
import { taskPrompt, TASK_SCHEMA } from './prompts.js'
import { noLinks, plainStyle } from './style.js'
import { currentTurn, ownerSystem, roundSection, staffSystem } from './system.js'
import { roundTools, staffTools, teamTools } from './tools.js'

export { untilFrom } from './tools.js'
export { noLinks, plainStyle } from './style.js'

/**
 * Агент в боте. Включается, когда правила (parse.js) не поняли человека:
 * «отхожу на 30 минут» и кнопки работают без ИИ и бесплатно. Агент
 * отвечает, смотрит CRM и делает дело инструментами (tools.js). Нет
 * ключа, кончился бюджет, сбой — false, и бот отвечает как раньше.
 *
 * Кто с кем говорит:
 * - сотрудник — о себе: задачи, баллы, отлучки, напоминания, скрины;
 * - руководитель — о себе и о специалистах своего отдела;
 * - Ян — обо всей команде: спрашивает, поручает написать людям, просит
 *   отчёт, таблицу или документ.
 * Если Ян поручил опросить команду, агент ведёт разговор с каждым по этому
 * поручению, пока не соберёт ответ.
 */

const REPLY_MAX = 1500
const OWNER_REPLY_MAX = 3500
const NOTE_EVERY_MS = 10 * 60000
const NOTES_PER_DAY = 5

export const AI_LIMIT_TEXT = 'Лимит вопросов на сегодня закончился.\nОн обновится в 00:00 по Москве.'
export const AI_MONTH_TEXT = 'Бюджет на ИИ в этом месяце закончился.\nДо 1-го числа я понимаю только команды.'
const AI_FAIL_TEXT = 'Не получилось ответить, сбой у ИИ.\nПопробуй ещё раз через минуту.'
const ROUND_ACK = 'Спасибо, записал и передам.'

/**
 * Важное — Яну: не ночью, не чаще раза в 10 минут и не больше пяти в день
 * от человека. true — ушло.
 */
async function noteToOwner(user, note, text, now = new Date()) {
  if (!String(note ?? '').trim() || isQuietHour(now)) return false
  const day = mskDayKey(now)
  const today = await prisma.botNotice.findMany({ where: { key: { startsWith: `ai-note:${user.id}:${day}:` } }, select: { sentAt: true } })
  if (today.length >= NOTES_PER_DAY) return false
  if (today.some((n) => Date.now() - n.sentAt.getTime() < NOTE_EVERY_MS)) return false
  await prisma.botNotice.create({ data: { key: `ai-note:${user.id}:${day}:${today.length + 1}` } })
  const person = await prisma.user.findUnique({ where: { id: user.id }, select: { id: true, name: true, role: true, department: { select: { name: true } } } })
  const res = await tellOwners(
    `<b>Важное от агента</b>\n${escapeHtml(person ? labelOf(person) : nameOf(user))}\n${escapeHtml(plainStyle(noLinks(cut(note, 300))))}\n\n<i>${escapeHtml(noLinks(cut(text, 300)))}</i>`,
  )
  return res.ok
}

/** «Печатает…», пока агент думает: телеграм гасит его через 5 секунд. */
function typing(chatId) {
  sendChatAction(chatId)
  const timer = setInterval(() => sendChatAction(chatId), 4500)
  return () => clearInterval(timer)
}

// Инструменты, которые только читают. Если модель вызвала лишь их и
// ничего не сказала, человек остался бы без ответа.
const READ_ONLY = new Set(['get_team', 'get_person', 'get_works', 'get_round'])
const acted = (tools = []) => tools.some((t) => !READ_ONLY.has(t))

/** Что сказать, когда ИИ сейчас недоступен по деньгам или лимиту. */
export function limitText({ status, why }, owner) {
  const base = status === 'budget' && why === 'month' ? AI_MONTH_TEXT : AI_LIMIT_TEXT
  return owner ? base : `${base}\n\nОтлучки, напоминания и списки задач работают как обычно.`
}

/** Инструменты по тому, кто пишет и идёт ли разговор по поручению. */
function toolsFor(ctx, { owner, lead, target }) {
  if (owner) return teamTools(ctx)
  return [
    ...staffTools(ctx),
    ...(lead ? teamTools(ctx, { team: true }) : []),
    ...(target && target.status !== 'answered' ? roundTools(ctx, target) : []),
  ]
}

/**
 * Сообщение, которое правила не поняли. files — что прислали: фото,
 * документы, видео ({ fileId, kind, mime }). loggedIds — записи журнала
 * этого сообщения (у альбома их несколько). kind — own (своё) или reply
 * (ответ на вопрос бота). true — агент ответил; false — пусть бот ответит
 * как без ИИ.
 */
export async function agentReply({ user, chatId, text = '', logged = null, loggedIds = [], files = [], kind = 'own', extend = false }, now = new Date()) {
  // Токены — только на активных людей из CRM. Чужих сюда не пускает
  // привязка чата, но проверяем и здесь, прямо перед запросом.
  const owner = user?.role === 'admin'
  if (!user?.active || !(owner || isParticipant(user)) || (!text && !files.length)) return false
  const lead = user.role === 'lead'
  const team = owner || lead

  // Идёт разговор по поручению: всё, что сюда дошло, уйдёт в отчёт.
  const target = owner ? null : await activeTarget(user.id, now)
  const ids = loggedIds.length ? loggedIds : [logged?.id].filter(Boolean)
  const ack = async () => {
    await tellChat(chatId, ROUND_ACK, { userId: user.id, roundTargetId: target.id })
    return true
  }
  if (target) {
    await linkMessages(target.id, ids)
    // Разговор затянулся — дальше просто записываем.
    if (target.replies >= ROUND_REPLIES_MAX) return ack()
  }

  // Деньги и лимит — до того, как считать данные CRM и качать фото.
  const check = await preflight({ userId: user.id, role: user.role, kind: target ? 'round' : kind })
  if (check.status !== 'ok') {
    if (target) return ack()
    if (check.status === 'off' || kind !== 'own') return false
    // Не «не понял тебя»: иначе кажется, что бот сломался.
    await tellChat(chatId, limitText(check, owner), { userId: user.id })
    return true
  }

  const ctx = {
    user, chatId, text, logged, now, extend,
    noteToOwner: (note) => noteToOwner(user, note, text, now),
  }
  const stop = typing(chatId)
  try {
    const [brief, rows, media] = await Promise.all([
      owner ? teamBrief(user, now) : staffBrief(user.id, now),
      recentRows(user.id, { exceptIds: ids, now }),
      fileBlocks(files),
    ])
    const dynamic = target
      ? roundSection({
        ownerLabel: target.round.owner.role === 'admin' ? 'Яна' : `руководителя ${labelOf(target.round.owner)}`,
        topic: target.round.topic,
        text: target.text,
        deadlineAt: target.round.deadlineAt,
        status: target.status,
        replies: target.replies,
        maxReplies: ROUND_REPLIES_MAX,
      })
      : null
    const res = await runAgent({
      userId: user.id,
      role: user.role,
      kind: target ? 'round' : kind,
      system: [owner ? ownerSystem() : staffSystem({ lead }), dynamic],
      tools: toolsFor(ctx, { owner, lead, target }),
      messages: toMessages(rows, currentTurn({ brief: cut(brief, MAX_INPUT_CHARS), text, notes: media.notes, media: media.blocks }), { strict: team }),
      maxTokens: team ? MAX_OUTPUT_TOKENS_TEAM : MAX_OUTPUT_TOKENS,
      maxSteps: team ? 8 : 4,
      effort: owner ? 'medium' : 'low',
      deadlineMs: team ? 150_000 : 60_000,
      // Фото и сводку по команде второй и следующий шаги читают из кэша.
      cacheTurn: team || media.blocks.length > 0,
    })

    // Ответ на «до скольки?»: время не нашлось — пусть бот скажет «не понял время».
    if (extend && !ctx.awaySet) return false
    if (res.status === 'ok' && res.text) {
      // Черновик, файл или отчёт бот уже показал — «Готово, жми Отправить» лишнее.
      if (ctx.quiet && res.text.length <= 200) return true
      await tellChat(chatId, escapeHtml(plainStyle(cut(res.text, team ? OWNER_REPLY_MAX : REPLY_MAX))), { userId: user.id, source: 'ai', roundTargetId: target?.id ?? null })
      if (target) await countReply(target.id)
      return true
    }
    // Действие уже выполнено и само ответило человеку — даже если потом
    // запрос сорвался, «не понял» не нужно.
    if (acted(res.tools) || ctx.quiet) return true
    if (target) return ack()
    if (res.status === 'limit' || res.status === 'budget') {
      if (kind !== 'own') return false
      await tellChat(chatId, limitText(res, owner), { userId: user.id })
      return true
    }
    // Ян и руководитель ждут ответа на поручение — честно про сбой, а не подсказка.
    if (team || res.tools.length) {
      await tellChat(chatId, AI_FAIL_TEXT, { userId: user.id })
      return true
    }
    return false
  } catch (e) {
    console.error(`[агент] сообщение: ${e.name}`)
    if (target) return ack()
    return false
  } finally {
    stop()
  }
}

/**
 * Сложность личной задачи по смыслу — для подсказки в «На проверке».
 * Один раз на заявку (ключ в BotNotice), не вышло — остаётся оценка по
 * длине описания. Никогда не бросает: рассылка заявок важнее оценки.
 */
export async function aiRateReview(review) {
  if (!aiEnabled() || !review.taskTitle || !review.complexity) return review.complexity
  try {
    const key = `ai-rated:${review.id}`
    if (await prisma.botNotice.findUnique({ where: { key } })) return review.complexity
    await prisma.botNotice.create({ data: { key } })
    const out = await askJson({ userId: review.userId, kind: 'task', ...taskPrompt({ title: review.taskTitle, description: review.taskDescription }), schema: TASK_SCHEMA })
    if (!out?.complexity || out.complexity === review.complexity) return review.complexity
    await prisma.motivationReview.update({ where: { id: review.id }, data: { complexity: out.complexity } })
    return out.complexity
  } catch (e) {
    console.error('[ИИ] оценка задачи:', e.message)
    return review.complexity
  }
}
