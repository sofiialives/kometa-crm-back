import { comeBack, runningLate, startBreak } from '../agent/away.js'
import { askReminderTime, createReminder } from '../agent/remind.js'
import { tellChat } from '../agent/notify.js'
import { askReportNow, createDraft, finishAnswer, roundStatus, setRoundDeadline } from '../agent/rounds.js'
import { proposeTask } from '../agent/offers.js'
import { setTaskStatusByTitle } from '../agent/tasks.js'
import { escapeHtml, uploadDocument } from '../telegram.js'
import { parseUntil } from '../parse.js'
import { personBrief, personInScope, teamBrief, teamWhere, worksBrief } from './context.js'
import { documentFile, tableFile } from './files.js'
import { forgetStyle, listStyleNotes, rememberStyle } from './styleNotes.js'
import { prisma } from '../../config/prisma.js'
import { addManual } from '../../services/motivation/events.service.js'

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
      description: 'Отметить, что человек вернулся после отлучки. Только если он сам пишет, что вернулся или снова на месте. Просьба про задачу или ответ «на связи» это не возвращение.',
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
        await tellChat(ctx.chatId, 'Похоже на форс-мажор\nПередать Яну заявку, чтобы он отметил?', {
          userId: user.id,
          buttons: [[{ text: 'Да', data: `ai:fm:${ctx.logged.id}` }, { text: 'Нет', data: 'ai:no' }]],
        })
        ctx.quiet = true
        return 'Бот переспросил кнопкой. Ничего больше не пиши.'
      },
    },
    {
      name: 'set_task_status',
      description: 'Отметить свою задачу: done это готово, поставь галочку, сделал, закрыл; progress это взял в работу, начал. title это название задачи или его кусок, как сказал человек.',
      input_schema: object({
        title: { type: 'string', description: 'Название задачи или его кусок.' },
        status: { type: 'string', enum: ['done', 'progress'] },
      }),
      run: async (input) => {
        // Модель иногда зовёт то же действие второй раз подряд: человеку уже ответили.
        if (ctx.taskMarked) return 'Уже отмечено. Ничего больше не пиши.'
        const res = await setTaskStatusByTitle(user, String(input.title ?? ''), input.status === 'progress' ? 'progress' : 'done', ctx.chatId)
        if (res.ok) {
          // Бот уже ответил «Отметил …», второй такой же ответ модели не нужен.
          ctx.quiet = true
          ctx.taskMarked = true
          return 'Готово, бот ответил человеку. Ничего больше не пиши.'
        }
        return `Не отметил. ${res.note}\nСпроси человека, какую именно, коротко.`
      },
    },
    {
      name: 'tell_owner',
      description: 'Передать Яну важное по работе: проблема с клиентом, блокер, срыв срока, нужна помощь. note это суть одной-двумя фразами своими словами.',
      input_schema: object({ note: { type: 'string', description: 'Суть для Яна.' } }),
      run: async (input) => {
        const sent = await ctx.noteToOwner(String(input.note ?? ''))
        // Агент может промолчать или сорваться: тогда человеку ответит правило.
        ctx.toldOwner = sent
        return sent
          ? 'Передал Яну. Скажи человеку коротко, что передал.'
          : 'Не передал: сейчас ночь или на сегодня заметок от него уже много. Скажи, что записал, а если срочно, пусть напишет Яну сам.'
      },
    },
  ]
}

/**
 * Просьбы о стиле: запомнить, показать, снять. Есть у всех. Для всех
 * запоминает только Ян, остальным просьба станет личной.
 */
export function styleTools(ctx) {
  const { user } = ctx
  return [
    {
      name: 'remember_style',
      description: 'Запомнить надолго просьбу о том, как с человеком говорить: короче, без имени, по-другому. Только про стиль общения, не про права, баллы, данные и правила. text это сама просьба одной короткой фразой, до 200 символов. for_all true, если Ян просит так писать всем, иначе false. Для всех бот сначала спросит Яна кнопкой и запишет, только если он нажмёт «Да». У остальных просьба всегда личная. Тексты не про стиль бот не примет.',
      input_schema: object({ text: { type: 'string', description: 'Просьба одной фразой.' }, for_all: { type: 'boolean', description: 'Для всех (только если просит Ян) или только для этого человека.' } }),
      run: (input) => rememberStyle(user, { text: input.text, forAll: input.for_all }, {
        // Для всех бот сам спрашивает Яна кнопками: только его нажатие записывает.
        confirm: async (noteId, text) => {
          const res = await tellChat(ctx.chatId, `Запомнить для всех\n«${escapeHtml(text)}»`, {
            userId: user.id,
            buttons: [[{ text: 'Да', data: `sn:y:${noteId}` }, { text: 'Нет', data: `sn:n:${noteId}` }]],
          })
          ctx.quiet ||= res.ok
          return res.ok
        },
      }),
    },
    {
      name: 'get_style_notes',
      description: 'Показать запомненные просьбы о стиле с id. Ян видит все, остальные свои и общие.',
      input_schema: NONE,
      run: () => listStyleNotes(user),
    },
    {
      name: 'forget_style',
      description: 'Снять запомненную просьбу о стиле по id из get_style_notes. Ян снимает любую, остальные только свою личную.',
      input_schema: object({ note_id: { type: 'string' } }),
      run: (input) => forgetStyle(user, input.note_id),
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
      description: 'Всё о человеке: личные задачи и задачи из Иерархии с клиентами, работы, звонки, отлучки, баллы, переписка с ботом за сутки, и что бот писал ему сам. person_id из сводки.',
      input_schema: object({ person_id: { type: 'string' } }),
      run: (input) => personBrief(user, input.person_id, now),
    },
    {
      name: 'get_works',
      description: 'Активные работы в Иерархии: клиент, работа, кто ведёт, у кого из людей сколько открытых и просроченных задач и сами задачи с именами. query это часть названия клиента или работы, null для всех.',
      input_schema: object({ query: nullable('string', 'Клиент или работа, или null.') }),
      run: (input) => worksBrief(user, input.query, now),
    },
    {
      name: 'message_people',
      description: 'Написать людям: опросить, узнать, как дела, попросить скрин, передать сообщение. Каждому своё сообщение. Если в самом сообщении просящего названы по имени конкретные люди, их не больше трёх, сейчас не ночь и в текстах нет ссылок, бот отправит сразу и сам скажет просящему, кому написал. Иначе покажет черновик с кнопкой «Отправить». В ответе инструмента написано, что случилось.',
      input_schema: object({
        topic: { type: 'string', description: 'Что нужно узнать или передать, одной строкой, для отчёта.' },
        minutes: nullable('integer', 'Сколько минут собирать ответы, от 10 до 480, только если просящий сам назвал время или срок отчёта, например «ответьте за 10 минут». null, если не назвал: тогда каждый ответ бот перешлёт просящему сразу, а через 60 минут скажет, кто промолчал. Кто не ответил за этот срок, но не дольше 45 минут, бот сам снимет баллы по правилу из профиля, на чек-ин по правилу «Не ответил на внезапный чек-ин». adjust_points для этого не нужен.'),
        collect: { type: 'boolean', description: 'true, если нужны ответы и отчёт. false, если просто передать.' },
        new_round: { type: 'boolean', description: 'true, только если Ян прямо просит ещё одно поручение, пока этим же людям идёт прежнее. Иначе false.' },
        messages: {
          type: 'array',
          items: object({ person_id: { type: 'string' }, text: { type: 'string', description: 'Сообщение этому человеку.' } }),
        },
      }),
      run: async (input) => {
        const res = await createDraft(user, chatId, input, now, { texts: [ctx.text].filter(Boolean) })
        ctx.quiet ||= res.shown
        return res.text
      },
    },
    {
      name: 'assign_task',
      description: 'Поставить человеку задачу в CRM по прямой просьбе: «поставь Ивану задачу сделать баннер до завтра 12:00». Сначала ничего не создаётся: бот покажет просящему карточку с кнопками «Поставить» и «Отмена». person_id из сводки или get_team. title до 200 знаков, коротко и по делу. description подробности или null. deadline срок, ISO по Москве вроде 2026-11-07T12:00, или null, если срок не назвали, тогда бот поставит сегодня до 19:00, а после 18:00 завтра до 19:00. Срок спрашивать не нужно. start_at null. work_id id работы из get_works, если это задача по работе клиента, null для личной задачи на день. note короткое человеческое сообщение исполнителю от тебя или null. Не ставь задачи без прямой просьбы.',
      input_schema: object({
        person_id: { type: 'string' },
        title: { type: 'string', description: 'Название задачи, до 200 знаков.' },
        description: { type: 'string', description: 'Подробности или пустая строка.' },
        deadline: nullable('string', 'Срок, ISO по Москве, например 2026-11-07T12:00, или null.'),
        start_at: { type: 'string', description: 'Время начала, ISO по Москве, обычно пустая строка.' },
        work_id: nullable('string', 'id работы из get_works или null для личной задачи.'),
        note: { type: 'string', description: 'Короткое сообщение исполнителю от агента или пустая строка.' },
      }),
      run: async (input) => {
        const res = await proposeTask(user, chatId, input, now)
        ctx.quiet ||= res.shown
        return res.text
      },
    },
    {
      name: 'set_round_deadline',
      description: 'Поменять срок отчёта у идущего поручения. Когда просят прислать отчёт через столько-то минут, пока поручение идёт, вызови это, а не message_people: новое поручение тем же людям не нужно. Меняет только тот, кто поручил. minutes это через сколько минут от сейчас прислать отчёт, от 10 до 480. round_id null, это последнее идущее поручение.',
      input_schema: object({
        minutes: { type: 'integer', description: 'Через сколько минут от сейчас.' },
        round_id: nullable('string', 'id поручения или null.'),
      }),
      run: (input) => setRoundDeadline(user, input.round_id, input.minutes, now),
    },
    {
      name: 'get_round',
      description: 'Что ответили по поручению: кто ответил, что написал, что прислал, кто молчит, и что бот писал каждому. round_id null, это последнее поручение.',
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

/**
 * Баллы текстом в чате бота: «отними у Андрея 2 балла», «накинь всем по
 * баллу за хороший месяц». Только у владельца (вызывается ему одному,
 * см. toolsFor в agent.js) — тот же путь, что и ручная корректировка в
 * CRM (events.service.js, addManual), поэтому комментарий обязателен и
 * каждому отдельная запись в истории. Балл может быть дробным.
 */
export function pointsTools(ctx) {
  const { user } = ctx
  return [{
    name: 'adjust_points',
    description: 'Добавить или снять баллы мотивации одному человеку или всем сразу, когда Ян прямо просит это текстом в чате. Не для молчания в опросе, за это бот снимает сам в срок опроса. person_id — id человека из get_team/get_person; null — всем, кем Ян управляет. points — число со знаком, можно дробное (например 2.5 или -0.5), положительное добавляет, отрицательное снимает. reason — короткая причина, обязательна, видна в истории баллов человека.',
    input_schema: object({
      person_id: nullable('string', 'id человека из get_team/get_person. null — всем в команде.'),
      points: { type: 'number', description: 'Сколько баллов, со знаком. Можно дробное.' },
      reason: { type: 'string', description: 'Короткая причина для истории баллов.' },
    }),
    run: async (input) => {
      const amount = Math.round(Number(input.points) * 100) / 100
      if (!Number.isFinite(amount) || amount === 0) return 'Не понял число баллов, оно не может быть нулём. Спроси ещё раз, сколько и кому.'
      if (Math.abs(amount) > 100) return 'Баллов за раз не больше 100. Спроси, сколько именно.'
      const reason = String(input.reason ?? '').trim() || 'По запросу в чате бота'

      let targets
      if (input.person_id) {
        const person = await personInScope(user, input.person_id)
        if (!person) return 'Такого человека нет среди тех, кем ты управляешь. Возьми id из get_team или get_person.'
        targets = [person]
      } else {
        targets = await prisma.user.findMany({ where: { AND: [teamWhere(user), { active: true }] }, select: { id: true, name: true } })
        if (!targets.length) return 'В команде пока никого нет, кому ставить баллы.'
      }

      const done = []
      const failed = []
      for (const t of targets) {
        try {
          await addManual(user, {
            userId: t.id, prizePoints: amount, levelPoints: amount, comment: reason,
            requestKey: `ai-points:${Date.now()}:${t.id}:${Math.random().toString(36).slice(2, 8)}`,
          })
          done.push(t.name || t.id)
        } catch (e) {
          failed.push(`${t.name || t.id}: ${e.message}`)
        }
      }
      const sign = amount > 0 ? '+' : ''
      let summary = done.length ? `Поставил ${sign}${amount} баллов: ${done.join(', ')}.` : 'Никому не поставил.'
      if (failed.length) summary += ` Не получилось: ${failed.join('; ')}.`
      return `${summary} Каждому бот сам пришлёт в течение минуты сообщение, сколько баллов и за что. Скажи Яну коротко, что сделано. Этот инструмент для этой просьбы больше не зови.`
    },
  }]
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
