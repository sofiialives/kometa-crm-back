import { comeBack, runningLate, startBreak } from '../agent/away.js'
import { askReminderTime, createReminder } from '../agent/remind.js'
import { tellChat } from '../agent/notify.js'
import { askReportNow, createDraft, finishAnswer, roundStatus } from '../agent/rounds.js'
import { uploadDocument } from '../telegram.js'
import { parseUntil } from '../parse.js'
import { personBrief, teamBrief, worksBrief } from './context.js'
import { documentFile, tableFile } from './files.js'

/**
 * Инструменты агента. Каждый — описание для модели и функция. Действия
 * над отлучками и напоминаниями выполняют те же функции, что и по
 * правилам, и сами отвечают человеку стандартной фразой. Модели
 * возвращаем короткий итог: что сделано и что ей делать дальше.
 *
 * Схемы строгие: все поля обязательны, необязательное — через null.
 */

const MAX_BREAK_MIN = 8 * 60
const nullable = (type, description) => ({ anyOf: [{ type }, { type: 'null' }], description })
const object = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false })
const NONE = object({})

/** До какого времени: «ЧЧ:ММ» или «через N минут». */
export function untilFrom({ until, minutes }, now = new Date()) {
  if (until && /^\d{1,2}[:.]\d{2}$/.test(String(until).trim())) {
    const at = parseUntil(`до ${String(until).trim()}`, now)
    if (at) return at
  }
  if (Number.isInteger(minutes) && minutes > 0 && minutes <= MAX_BREAK_MIN) {
    return new Date(new Date(now).getTime() + minutes * 60000)
  }
  return null
}

const TIME = {
  minutes: nullable('integer', 'Через сколько минут или на сколько минут, если человек сказал так. Иначе null.'),
  until: nullable('string', 'До какого времени или во сколько, ЧЧ:ММ по Москве, если человек назвал время. Иначе null.'),
}

/**
 * Инструменты сотрудника — о нём самом. ctx: { user, chatId, text,
 * logged, now, extend, noteToOwner }. extend — человек отвечает на «до
 * скольки задерживаешься?», отлучку продлеваем.
 */
export function staffTools(ctx) {
  const { user, now } = ctx
  return [
    {
      name: 'set_away',
      description: 'Отметить, что человек отходит: обед, врач, банк, по делам. Если время не сказал, оба поля null, бот сам спросит кнопками.',
      input_schema: object(TIME),
      run: async (input) => {
        const until = untilFrom(input, now)
        // Ответ на «до скольки задерживаешься?»: без времени ничего не меняем.
        if (ctx.extend && !until) return 'Время не понял, ничего не меняй и ничего не пиши.'
        const res = await startBreak(user, { until, note: ctx.text, extend: Boolean(ctx.extend) }, now)
        ctx.awaySet = Boolean(until)
        return until || res?.type !== 'started' ? 'Готово, бот ответил человеку.' : 'Бот спросил кнопками, на сколько он отходит.'
      },
    },
    {
      name: 'come_back',
      description: 'Отметить, что человек вернулся и на месте.',
      input_schema: NONE,
      run: async () => {
        await comeBack(user, now)
        return 'Готово, бот ответил человеку.'
      },
    },
    {
      name: 'running_late',
      description: 'Человек задерживается: к началу работы, к задаче или после отлучки. Бот передаст Яну.',
      input_schema: object(TIME),
      run: async (input) => {
        await runningLate(user, { until: untilFrom(input, now), text: ctx.text }, now)
        return 'Готово, бот ответил человеку и передал Яну.'
      },
    },
    {
      name: 'set_reminder',
      description: 'Поставить человеку напоминание на сегодня или завтра. text это о чём напомнить, коротко, например «позвонить клиенту». Время не сказал, оба поля времени null, бот спросит.',
      input_schema: object({ text: { type: 'string', description: 'О чём напомнить.' }, ...TIME }),
      run: async (input) => {
        const when = untilFrom(input, now)
        const text = String(input.text ?? '').trim() || ctx.text
        if (when) await createReminder(user, when, text, now)
        else await askReminderTime(user, text)
        return when ? 'Готово, бот ответил человеку.' : 'Бот спросил, когда напомнить.'
      },
    },
    {
      name: 'end_day',
      description: 'Человек закончил рабочий день и уходит. Бот переспросит кнопкой.',
      input_schema: NONE,
      run: async () => {
        await tellChat(ctx.chatId, 'Правильно понял, на сегодня всё и ты заканчиваешь рабочий день?', {
          userId: user.id,
          buttons: [[{ text: 'Да', data: 'ai:de' }, { text: 'Нет', data: 'ai:no' }]],
        })
        ctx.quiet = true
        return 'Бот переспросил кнопкой. Ничего больше не пиши.'
      },
    },
    {
      name: 'force_majeure',
      description: 'Заболел, случилось ЧП или сегодня не сможет работать. Бот переспросит кнопкой и передаст Яну заявку со словами человека.',
      input_schema: NONE,
      run: async () => {
        if (!ctx.logged?.id) return 'Не вышло, нет текста заявки. Попроси написать одной строкой, что случилось и до какого времени.'
        await tellChat(ctx.chatId, 'Похоже на форс-мажор. Передать Яну заявку, чтобы он отметил?', {
          userId: user.id,
          buttons: [[{ text: 'Да', data: `ai:fm:${ctx.logged.id}` }, { text: 'Нет', data: 'ai:no' }]],
        })
        ctx.quiet = true
        return 'Бот переспросил кнопкой. Ничего больше не пиши.'
      },
    },
    {
      name: 'tell_owner',
      description: 'Передать Яну важное по работе: проблема с клиентом, блокер, срыв срока, нужна помощь. note это суть одной-двумя фразами своими словами.',
      input_schema: object({ note: { type: 'string', description: 'Суть для Яна.' } }),
      run: async (input) => {
        const sent = await ctx.noteToOwner(String(input.note ?? ''))
        return sent
          ? 'Передал Яну. Скажи человеку коротко, что передал.'
          : 'Не передал: сейчас ночь или на сегодня заметок от него уже много. Скажи, что записал, а если срочно, пусть напишет Яну сам.'
      },
    },
  ]
}

/**
 * Инструменты того, кто ведёт людей: Яна — по всей команде, руководителя —
 * по специалистам своего отдела. ctx: { user, chatId, now }. ctx.quiet —
 * бот уже показал результат сам (черновик, файл, отчёт), короткая
 * приписка модели не нужна.
 */
export function teamTools(ctx, { team = false } = {}) {
  const { user, chatId, now } = ctx
  // Сводка по команде у Яна уже в каждом сообщении; руководителю — по запросу.
  return [
    ...(team ? [{
      name: 'get_team',
      description: 'Сводка по команде на сейчас: кто где, задачи, баллы, отлучки, у кого нет телеграма. У каждого id для других инструментов.',
      input_schema: NONE,
      run: () => teamBrief(user, now),
    }] : []),
    {
      name: 'get_person',
      description: 'Всё о человеке: личные задачи и задачи из Иерархии с клиентами, работы, звонки, отлучки, баллы, что писал боту за сутки. person_id из сводки.',
      input_schema: object({ person_id: { type: 'string' } }),
      run: (input) => personBrief(user, input.person_id, now),
    },
    {
      name: 'get_works',
      description: 'Активные работы в Иерархии: клиент, работа, кто ведёт, сколько задач открыто и просрочено. query это часть названия клиента или работы, null для всех.',
      input_schema: object({ query: nullable('string', 'Клиент или работа, или null.') }),
      run: (input) => worksBrief(user, input.query, now),
    },
    {
      name: 'message_people',
      description: 'Написать людям: опросить, узнать, как дела, попросить скрин, передать сообщение. Каждому своё сообщение. Бот покажет черновик с кнопкой «Отправить».',
      input_schema: object({
        topic: { type: 'string', description: 'Что нужно узнать или передать, одной строкой, для отчёта.' },
        minutes: nullable('integer', 'Сколько минут собирать ответы, от 10 до 480. null, если не сказали, тогда 60.'),
        collect: { type: 'boolean', description: 'true, если нужны ответы и отчёт. false, если просто передать.' },
        messages: {
          type: 'array',
          items: object({ person_id: { type: 'string' }, text: { type: 'string', description: 'Сообщение этому человеку.' } }),
        },
      }),
      run: async (input) => {
        const res = await createDraft(user, chatId, input, now)
        ctx.quiet ||= res.shown
        return res.text
      },
    },
    {
      name: 'get_round',
      description: 'Что ответили по поручению: кто ответил, что написал, что прислал, кто молчит. round_id null, это последнее поручение.',
      input_schema: object({ round_id: nullable('string', 'id поручения или null.') }),
      run: (input) => roundStatus(user, input.round_id),
    },
    {
      name: 'send_round_report',
      description: 'Прислать отчёт по поручению сразу, не дожидаясь срока, и закончить сбор. Бот сначала переспросит кнопкой. round_id null, это последнее поручение.',
      input_schema: object({ round_id: nullable('string', 'id поручения или null.') }),
      run: async (input) => {
        const res = await askReportNow(user, chatId, input.round_id)
        ctx.quiet ||= res.shown
        return res.text
      },
    },
    {
      name: 'make_table',
      description: 'Сделать таблицу Excel и прислать файлом сюда в чат. Например сводку по команде или по ответам. Ячейки короткие, без переносов строк.',
      input_schema: object({
        title: { type: 'string', description: 'Название без даты, дату бот допишет сам.' },
        columns: { type: 'array', items: { type: 'string' } },
        rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
      }),
      run: async (input) => {
        const file = await tableFile(input, now)
        const res = await uploadDocument(chatId, file.buffer, file.name, { mime: file.mime })
        ctx.quiet ||= res.ok
        return res.ok ? `Файл ${file.name} отправлен. Ничего больше не пиши.` : 'Файл не отправился. Скажи об этом коротко.'
      },
    },
    {
      name: 'make_document',
      description: 'Сделать документ Word и прислать файлом сюда в чат. Разделы с заголовком, абзацами и пунктами.',
      input_schema: object({
        title: { type: 'string', description: 'Название без даты, дату бот допишет сам.' },
        sections: {
          type: 'array',
          items: object({
            heading: nullable('string', 'Заголовок раздела или null.'),
            paragraphs: { type: 'array', items: { type: 'string' } },
            bullets: { type: 'array', items: { type: 'string' } },
          }),
        },
      }),
      run: async (input) => {
        const file = await documentFile(input, now)
        const res = await uploadDocument(chatId, file.buffer, file.name, { mime: file.mime })
        ctx.quiet ||= res.ok
        return res.ok ? `Файл ${file.name} отправлен. Ничего больше не пиши.` : 'Файл не отправился. Скажи об этом коротко.'
      },
    },
  ]
}

/** В разговоре по поручению — записать ответ. */
export function roundTools(ctx, target) {
  return [{
    name: 'finish_answer',
    description: 'Ответ человека по поручению понятен: записать суть для отчёта. Что делает, на каком этапе, что прислал, что мешает, когда сдаст.',
    input_schema: object({ summary: { type: 'string' } }),
    run: async (input) => {
      await finishAnswer(target.id, input.summary, ctx.now)
      return 'Записал. Ответь человеку одной короткой строкой.'
    },
  }]
}
