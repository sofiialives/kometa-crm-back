import { aiEnabled, getClient, markEngineStub, noteFailure, noteSuccess } from './client.js'
import { modelFor } from './cost.js'
import { hasAiBudget, recordTokens, takeAiCall } from './usage.js'

/**
 * Агент: модель отвечает человеку и сама решает, что посмотреть в CRM и что
 * сделать, — через инструменты (tools). Бот выполняет инструмент и
 * возвращает модели результат, пока она не напишет ответ.
 *
 * Модель выбирается по бюджету (cost.js): основная, запасная или никакой.
 * Сбой, лимит, отказ модели — status не ok, и бот отвечает по правилам.
 *
 * Инструмент: { name, description, input_schema, run(input) → строка }.
 * Схемы строгие (strict): все поля обязательны, лишних нет.
 */

let stub = null

/** Подмена модели в сквозных проверках: fn(запрос как для API и step) → ответ как у API. */
export function setEngineStub(fn) {
  stub = fn
  markEngineStub(Boolean(fn))
}

const MAX_TOOL_RESULT = 12000
// Больше вызовов за один шаг модели не выполняем: десятки get_person за раз
// — это уже не ответ, а перебор базы.
const MAX_CALLS_PER_STEP = 10

/** Описание инструментов для API — без функций. */
export function toolDefs(tools) {
  return tools.map(({ name, description, input_schema }) => ({ name, description, input_schema, strict: true }))
}

/** Инструмент по имени из ответа модели: она изредка путает регистр. */
export function findTool(tools, name) {
  return tools.find((t) => t.name === name) ?? tools.find((t) => t.name.toLowerCase() === String(name).toLowerCase()) ?? null
}

/** Текст ответа модели: только текстовые блоки, по типу, а не по месту. */
export function replyText(content) {
  return (content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim()
}

async function runTool(tools, use, extra) {
  if (extra) return { type: 'tool_result', tool_use_id: use.id, is_error: true, content: `За раз не больше ${MAX_CALLS_PER_STEP} вызовов. Этот не выполнен.` }
  const tool = findTool(tools, use.name)
  if (!tool) return { type: 'tool_result', tool_use_id: use.id, is_error: true, content: `Нет инструмента ${String(use.name).slice(0, 40)}. Есть ${tools.map((t) => t.name).join(', ')}.` }
  try {
    const out = await tool.run(use.input ?? {})
    return { type: 'tool_result', tool_use_id: use.id, content: String(out ?? 'Готово.').slice(0, MAX_TOOL_RESULT) || 'Готово.' }
  } catch (e) {
    console.error(`[агент] инструмент ${tool.name}: ${e.name}`)
    return { type: 'tool_result', tool_use_id: use.id, is_error: true, content: 'Не получилось, сбой в CRM. Скажи человеку, что сейчас не вышло, пусть попробует позже.' }
  }
}

const DEPS = {
  pick: (who) => modelFor(who, new Date()),
  can: (userId, kind, role) => hasAiBudget(userId, kind, new Date(), role),
  take: (userId, kind, role) => takeAiCall(userId, kind, new Date(), role),
  record: (userId, kind, usage, model) => recordTokens(userId, kind, usage, new Date(), model),
  create: (params, timeout) => (stub ? stub(params) : getClient().messages.create(params, { timeout, signal: AbortSignal.timeout(timeout) })),
}

/**
 * Можно ли сейчас звать модель — до того, как собирать данные CRM и качать
 * фото: человеку с выбранным лимитом сервер их не считает. status: ok, off,
 * limit (лимит человека) или budget (why: user, day, month).
 */
export async function preflight({ userId, role = null, kind = 'own' }, deps = {}) {
  const { pick, can } = { ...DEPS, ...deps }
  if (!deps.create && !aiEnabled()) return { status: 'off' }
  const choice = await pick({ userId, role })
  if (!choice.model) return { status: 'budget', why: choice.why }
  if (!(await can(userId, kind, role))) return { status: 'limit' }
  return { status: 'ok' }
}

/** Пометка для кэша на последнем блоке сообщения — новый объект, история не меняется. */
function cachedTail(message) {
  const content = Array.isArray(message.content) ? message.content : [{ type: 'text', text: String(message.content) }]
  return { ...message, content: [...content.slice(0, -1), { ...content.at(-1), cache_control: { type: 'ephemeral' } }] }
}

/**
 * Один ход разговора. system — [постоянная часть, переменная часть]:
 * постоянная вместе с инструментами кэшируется, и повторный запрос в
 * течение пяти минут стоит в десять раз дешевле. cacheTurn — кэшировать и
 * само сообщение (фото, сводку по команде): тогда второй и следующие шаги
 * читают его из кэша, а не платят за картинки снова.
 *
 * Возвращает { status, text, model, tools: [имена] }. status: ok — есть
 * ответ (text может быть пустым, если ответило действие); off — ИИ
 * выключен; limit — лимит человека; budget — деньги кончились (why);
 * refused — модель отказалась; error — сбой. tools — что успели вызвать,
 * даже при сбое: действие могло уже выполниться. С format (JSON-схема)
 * вместо text — data, разобранный ответ.
 *
 * deps — подмена базы и API в проверках: pick, can, take, record, create.
 */
export async function runAgent({
  userId, role = null, kind = 'own', system, tools = [], messages,
  maxTokens = 1500, maxSteps = 4, effort = 'low', deadlineMs = 60_000, format = null, cacheTurn = false,
}, deps = {}) {
  const { pick, take, record, create } = { ...DEPS, ...deps }
  if (!deps.create && !aiEnabled()) return { status: 'off', tools: [] }
  const choice = await pick({ userId, role })
  if (!choice.model) return { status: 'budget', why: choice.why, tools: [] }
  const { model } = choice
  // Лимит — по настоящему дню: один ход разговора — один запрос.
  if (!(await take(userId, kind, role))) return { status: 'limit', tools: [] }

  const [stable, dynamic] = system
  const systemBlocks = [{ type: 'text', text: stable, cache_control: { type: 'ephemeral' } }]
  if (dynamic) systemBlocks.push({ type: 'text', text: dynamic })
  const defs = toolDefs(tools)
  const history = cacheTurn && messages.length ? [...messages.slice(0, -1), cachedTail(messages.at(-1))] : [...messages]
  const used = []
  const started = Date.now()

  const ask = async (step, { last = false } = {}) => {
    const left = deadlineMs - (Date.now() - started)
    const params = {
      model,
      max_tokens: maxTokens,
      // У Sonnet 5.5 размышления не выключаются: на low он почти не думает
      // над простым и думает над сложным. Принудительный вызов
      // инструмента он тоже не принимает — только auto или none.
      thinking: { type: 'adaptive' },
      output_config: format ? { effort, format: { type: 'json_schema', schema: format } } : { effort },
      system: systemBlocks,
      messages: history,
      ...(defs.length ? { tools: defs, tool_choice: { type: last ? 'none' : 'auto' } } : {}),
    }
    const response = await create(stub || deps.create ? { ...params, step, messages: [...history] } : params, left)
    await record(userId, kind, response.usage, model)
    noteSuccess()
    return response
  }

  const finish = (response) => {
    const text = replyText(response.content)
    if (!format) return { status: 'ok', text, model, tools: used }
    // Строгий JSON по схеме: не разобрался — как сбой, бот обойдётся без ИИ.
    try {
      return { status: 'ok', data: JSON.parse(text), model, tools: used }
    } catch {
      return { status: 'error', model, tools: used }
    }
  }

  try {
    let step = 0
    for (; step < maxSteps; step += 1) {
      if (deadlineMs - (Date.now() - started) < 5000) break
      // Деньги кончились посреди хода — дальше не идём. Модель не меняем:
      // размышления одной модели другая не читает.
      if (step > 0 && !(await pick({ userId, role })).model) break
      const response = await ask(step)

      if (response.stop_reason === 'refusal') {
        console.error(`[агент] модель отказалась: ${response.stop_details?.category ?? 'без причины'}`)
        return { status: 'refused', model, tools: used }
      }
      // Ответ блоками как есть, вместе с размышлениями: модель их ждёт.
      history.push({ role: 'assistant', content: response.content })
      if (response.stop_reason === 'pause_turn') continue

      const uses = response.content.filter((b) => b.type === 'tool_use')
      if (response.stop_reason === 'tool_use' && uses.length) {
        const results = []
        for (const [i, use] of uses.entries()) {
          if (i < MAX_CALLS_PER_STEP) used.push(use.name)
          results.push(await runTool(tools, use, i >= MAX_CALLS_PER_STEP))
        }
        history.push({ role: 'user', content: results })
        continue
      }
      // Обрезанный вызов инструмента не выполняем: аргументы могли не дописаться.
      if (response.stop_reason === 'max_tokens' && uses.length) return { status: 'error', model, tools: used }
      return finish(response)
    }
    // Шаги или время кончились на инструментах — последний запрос без них:
    // пусть подведёт итог тем, что уже узнал, а не оставит человека без ответа.
    console.error(`[агент] ход не уложился в ${maxSteps} шагов`)
    if (history.at(-1)?.role === 'user' && deadlineMs - (Date.now() - started) >= 5000 && (await pick({ userId, role })).model) {
      const response = await ask(step, { last: true })
      if (response.stop_reason !== 'refusal') return { ...finish(response), exhausted: true }
    }
    return { status: 'error', model, tools: used, exhausted: true }
  } catch (e) {
    noteFailure(e)
    return { status: 'error', model, tools: used }
  }
}
