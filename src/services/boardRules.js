/**
 * Правила доски клиентов без базы данных — чтобы проверять их тестами.
 *
 * Здесь живёт всё, что решает «что показывать в выбранном периоде»; сервис
 * только достаёт данные из базы и отдаёт их сюда.
 */

import { MSK_OFFSET_MS } from './motivation/month.js'

/** Первое число месяца по UTC — к нему привязана каждая услуга. */
export function monthStart(value) {
  const d = new Date(value)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
}

/**
 * Границы выбранного периода.
 *
 * Возвращает null для режима «за всё время» — тогда фильтра по периоду нет
 * вовсе.
 *
 * В режиме произвольного периода месяц услуги входит в период, если первое
 * число месяца лежит в заданном диапазоне. Границы при этом НЕ округляем
 * до месяца: округление наружу превратило бы «последние 90 дней» в четыре
 * месяца вместо трёх, и сводка показала бы больше, чем есть.
 *
 * Следствие: выручка помесячная, половинок месяца не бывает. «С 15 сентября»
 * сентябрьскую выручку уже не захватит — первое число месяца осталось
 * позади. Сама услуга в таком периоде при этом видна, если работа по ней
 * шла в эти дни (см. serviceVisible).
 */
export function resolveRange({ mode, month, months, from, to }, now = new Date()) {
  if (mode === 'all') return null

  if (mode === 'month') {
    const start = monthStart(month)
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1))
    return { gte: start, lt: end }
  }

  // Скользящее окно: «последние три месяца» — это июль, август и сентябрь,
  // когда на дворе сентябрь. Считаем от сегодняшнего дня, а не от того,
  // когда ссылку открыли в прошлый раз: иначе «последний год» однажды
  // окажется позапрошлым.
  //
  // «Сегодня» — по Москве, как живёт всё агентство: Москва это UTC+3 без
  // перехода на летнее время. Иначе в ночь на первое число (до трёх часов,
  // пока по UTC ещё вчера) открывался бы прошлый месяц.
  //
  // Московское «сейчас» записываем как будто это UTC: месяц услуги хранится
  // первым числом в полночь UTC, и верхняя граница должна сравниваться с ним
  // в тех же единицах. С настоящим «сейчас» ноябрьская услуга первого числа
  // в час ночи по Москве оказалась бы «в будущем».
  if (mode === 'last') {
    const nowMsk = new Date(now.getTime() + MSK_OFFSET_MS)
    const start = new Date(Date.UTC(nowMsk.getUTCFullYear(), nowMsk.getUTCMonth() - (months - 1), 1))
    return { gte: start, lte: nowMsk }
  }

  const range = {}
  if (from) range.gte = new Date(from)
  if (to) range.lte = new Date(to)
  return Object.keys(range).length ? range : null
}

// ---------------------------------------------------------------------------
// Дни, сроки работ, пересечение с периодом
// ---------------------------------------------------------------------------

export const DAY_MS = 24 * 60 * 60 * 1000

/** Самый длинный срок работ по одной услуге, дней (оба края включительно). */
export const MAX_WORK_DAYS = 366

/** Полночь UTC того дня, на который приходится момент: сроки работ хранятся днями. */
export function dayStart(value) {
  const d = new Date(value)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

/** Первое число следующего месяца. */
function nextMonthStart(value) {
  const m = monthStart(value)
  return new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1))
}

/**
 * Срок работ с заполненными границами. Пустая граница — это край месяца
 * услуги: начало месяца слева и его последний день справа. Оба конца — дни
 * (полночь UTC), последний день входит в срок целиком.
 */
export function workSpan({ month, workFrom, workTo }) {
  return {
    from: workFrom ? dayStart(workFrom) : monthStart(month),
    to: workTo ? dayStart(workTo) : new Date(nextMonthStart(month).getTime() - DAY_MS),
  }
}

/** Услуга с заполненными workFrom/workTo — в таком виде её видит фронт. */
export function fillWorkSpan(service) {
  const { from, to } = workSpan(service)
  return { ...service, workFrom: from, workTo: to }
}

/**
 * Проблема в сроке работ или null. Принимает дни (см. dayStart).
 * Один текст на всех: его же показывает проверка входных данных.
 */
export function workSpanError(from, to) {
  if (from.getTime() > to.getTime()) return 'Срок работ: начало позже конца'
  if ((to.getTime() - from.getTime()) / DAY_MS + 1 > MAX_WORK_DAYS) {
    return `Срок работ не может быть длиннее ${MAX_WORK_DAYS} дней`
  }
  return null
}

/**
 * Проблема в сроке работ услуги или null. Проверяет срок вместе с месяцем
 * услуги: если задана одна граница, вторая берётся из месяца, и срок «с 5
 * декабря» у ноябрьской услуги вышел бы с началом позже конца.
 */
export function workSpanProblem({ month, workFrom, workTo }) {
  if (!workFrom && !workTo) return null
  const { from, to } = workSpan({ month, workFrom, workTo })
  const problem = workSpanError(from, to)
  if (!problem) return null
  return workFrom && workTo ? problem : `${problem} (вторая граница не задана, взят край месяца услуги)`
}

/** Момент раньше начала периода. */
function beforeRange(value, range) {
  return Boolean(range.gte) && new Date(value).getTime() < range.gte.getTime()
}

/** Момент позже конца периода. */
function afterRange(value, range) {
  const t = new Date(value).getTime()
  return (Boolean(range.lt) && t >= range.lt.getTime()) || (Boolean(range.lte) && t > range.lte.getTime())
}

/** Попадает ли момент в период. Период null — без границ, попадает всё. */
export function inRange(value, range) {
  return !range || (!beforeRange(value, range) && !afterRange(value, range))
}

/**
 * Пересекается ли отрезок [start, end) с периодом. Края — миллисекунды,
 * end может быть Infinity («пока не закончилось»). Пустой отрезок не
 * пересекается ни с чем.
 */
export function overlapsRange(range, start, end) {
  if (!range) return true
  if (end <= start) return false
  if (range.gte && end <= range.gte.getTime()) return false
  if (range.lt && start >= range.lt.getTime()) return false
  if (range.lte && start > range.lte.getTime()) return false
  return true
}

// ---------------------------------------------------------------------------
// Услуги в периоде
// ---------------------------------------------------------------------------

/**
 * Месяц услуги внутри периода — только такая услуга даёт выручку и расходы
 * в этом периоде: деньги по ней принадлежат её месяцу, а не месяцам доделок.
 */
export function serviceInPeriod(service, range) {
  return inRange(service.month, range)
}

/**
 * Услугу показываем в периоде, если её месяц в периоде ИЛИ срок работ
 * пересекается с периодом. Второй случай — доделки: услуга октября, над
 * которой работали ещё и в ноябре, видна в ноябре, но деньги остаются в
 * октябре. Последний день срока входит целиком, поэтому отрезок заканчивается
 * не в полночь этого дня, а в полночь следующего.
 */
export function serviceVisible(service, range) {
  if (!range) return true
  if (serviceInPeriod(service, range)) return true
  const { from, to } = workSpan(service)
  return overlapsRange(range, from.getTime(), to.getTime() + DAY_MS)
}

/**
 * Выручка, расходы, «не выплачено» и прибыль по набору услуг. Единственное
 * место, где это считается.
 *
 * Считаются только услуги, месяц которых в периоде. Доделки, видимые лишь
 * из-за срока работ, в сумму не входят, иначе деньги одной услуги легли бы в
 * два месяца сразу. Без периода (null) — считаются все.
 *
 * «Не выплачено» — расходы без отметки; на прибыль не влияет: расход
 * остаётся расходом, выплачен он или ещё нет.
 */
export function totals(services, range = null) {
  let revenueCents = 0
  let expenseCents = 0
  let unpaidCents = 0
  for (const s of services) {
    if (!serviceInPeriod(s, range)) continue
    revenueCents += s.revenueCents
    for (const e of s.expenses) {
      expenseCents += e.amountCents
      if (!e.paid) unpaidCents += e.amountCents
    }
  }
  return { revenueCents, expenseCents, unpaidCents, profitCents: revenueCents - expenseCents }
}

/**
 * Услуга для ответа: заполненный срок работ и признак «её месяц в периоде».
 * Цифры самой услуги (выручка, расходы, прибыль) остаются её собственными, и
 * у доделки тоже: по inPeriod фронт отличает те, что идут в итоги.
 */
export function shapeService(service, range) {
  return {
    ...fillWorkSpan(service),
    inPeriod: serviceInPeriod(service, range),
    ...totals([service]),
  }
}

// ---------------------------------------------------------------------------
// Карточки клиентов в периоде
// ---------------------------------------------------------------------------

/**
 * Есть ли карточка в выбранном периоде.
 *
 * Если у клиента есть видимая услуга — есть. Если услуги у него заведены, но
 * ни одна в период не попала — нет: клиент, пришедший в ноябре, не должен
 * висеть в октябре с «услуг не было». Месяц начала работы карточку сам по
 * себе не добавляет.
 *
 * Единственное исключение — уход: клиент, ушедший в этом периоде, виден в
 * нём в «Ушедших», даже если услуг и доделок в нём нет. Иначе уход
 * потерялся бы из счётчика ушедших за месяц.
 *
 * Клиент вообще без услуг виден по своим датам: с месяца начала работы и
 * дальше, пока не ушёл (месяц ухода ещё включён). Карточку только что
 * заведённого клиента без единой услуги иначе нигде не найти.
 */
export function cardVisible({ status, startedAt, leftAt, serviceCount, visibleCount }, range) {
  if (!range) return true
  if (visibleCount > 0) return true
  if (status === 'left' && leftAt && inRange(leftAt, range)) return true
  if (serviceCount > 0) return false
  const end = leftAt ? nextMonthStart(leftAt).getTime() : Infinity
  return overlapsRange(range, monthStart(startedAt).getTime(), end)
}

/**
 * В какой колонке карточка в выбранном периоде: 'active' или 'left'.
 *
 * В «Ушедших» клиент, который ушёл в этом периоде или раньше: если ушёл
 * раньше, а карточка всё равно видна, значит, по нему идут доделки. Ушёл
 * позже конца периода — в том периоде он ещё работал, поэтому «В работе».
 * Без периода колонку решает текущий статус.
 */
export function columnOf({ status, leftAt }, range) {
  if (status !== 'left') return 'active'
  if (!range || !leftAt) return 'left'
  return afterRange(leftAt, range) ? 'active' : 'left'
}

// ---------------------------------------------------------------------------
// Доска целиком
// ---------------------------------------------------------------------------

/** Сколько дней клиент с нами. У ушедшего счёт останавливается датой ухода. */
export function daysWithUs(card, now = new Date()) {
  const end = card.leftAt ? new Date(card.leftAt) : now
  return Math.max(0, Math.floor((end - new Date(card.startedAt)) / DAY_MS))
}

/**
 * Доска из карточек, прочитанных из базы вместе с услугами и их расходами:
 * сводка сверху и две колонки. В карточки для периода попадают не все, а
 * сводка знает всех (см. onBoardClientIds). Что видно и в какой колонке — решают правила
 * выше, здесь они только собираются в ответ.
 */
export function buildBoard(cards, range, now = new Date()) {
  const active = []
  const left = []
  const visibleServices = []

  for (const c of cards) {
    const visible = c.services.filter((s) => serviceVisible(s, range))
    if (!cardVisible({
      status: c.status,
      startedAt: c.startedAt,
      leftAt: c.leftAt,
      serviceCount: c.services.length,
      visibleCount: visible.length,
    }, range)) continue

    visibleServices.push(...visible)
    const card = {
      id: c.id,
      client: c.client,
      contact: c.contact,
      status: c.status,
      startedAt: c.startedAt,
      leftAt: c.leftAt,
      leftReason: c.leftReason,
      daysWithUs: daysWithUs(c, now),
      // Количество услуг за всё время — так и написано в задании, «не
      // зависящее от периода».
      serviceCountTotal: c.services.length,
      // Сколько услуг дают деньги в периоде, а сколько видно всего: разница
      // — доделки, их деньги лежат в другом месяце.
      serviceCountInPeriod: visible.filter((s) => serviceInPeriod(s, range)).length,
      serviceCountVisible: visible.length,
      ...totals(visible, range),
    }
    const column = columnOf(c, range) === 'left' ? left : active
    column.push(card)
  }

  return {
    // Сводка считается по обеим колонкам сразу: выручка ушедшего клиента за
    // тот месяц, когда он ещё работал, — это выручка агентства за тот месяц.
    summary: {
      ...totals(visibleServices, range),
      activeCount: active.length,
      leftCount: left.length,
      // Все клиенты на доске, а не только видимые в периоде: форма «Новый
      // клиент» по этому списку отказывает тем, кто уже заведён, а клиент
      // без услуг в этом месяце на экране не виден, но на доске есть. Это id
      // справочника клиентов (client.id), как и в карточках.
      onBoardClientIds: cards.map((c) => c.clientId),
    },
    active,
    left,
  }
}

// ---------------------------------------------------------------------------
// Список месяцев
// ---------------------------------------------------------------------------

/**
 * Месяцы, о которых «знает» услуга: её собственный и все, которые захватывает
 * срок работ. Для выпадающего списка: открыв такой месяц, доделки в нём
 * действительно видны.
 */
export function monthsOfService(service) {
  const own = monthStart(service.month)
  const months = [own]
  const { from, to } = workSpan(service)
  if (from.getTime() > to.getTime()) return months
  // Больше года подряд не бывает (MAX_WORK_DAYS), счётчик — страховка от
  // кривых данных, чтобы цикл не крутился вечно.
  for (let m = monthStart(from), i = 0; m.getTime() <= to.getTime() && i < 36; m = nextMonthStart(m), i += 1) {
    if (m.getTime() !== own.getTime()) months.push(m)
  }
  return months
}

// ---------------------------------------------------------------------------
// Деньги и расходы
// ---------------------------------------------------------------------------

// Деньги приходят с фронта в долларах, в базе лежат в центах. Округляем
// здесь один раз: дальше по всему коду только целые числа, и сложение
// никогда не даёт 0.30000000000000004.
export const toCents = (dollars) => Math.round(Number(dollars) * 100)

/** Сегодняшний день по Москве: полночь UTC этого числа, как у остальных дней доски. */
export function moscowToday(now = new Date()) {
  return dayStart(new Date(now.getTime() + MSK_OFFSET_MS))
}

/**
 * Дата выплаты расхода после того, как отметку поставили, сняли или
 * переправили. sentAt — день, который выбрал владелец (или пусто).
 *
 * Снята — даты нет. Выбрана — она и берётся, приведённая к дню. Не выбрана,
 * а расход уже был выплачен — остаётся прежняя: повторный запрос или правка
 * услуги не должны менять день, когда деньги ушли. Прежняя может быть пустой
 * (расходы, выплаченные до появления отметки): даты, которой никто не знает,
 * не выдумываем. Выплачен только что без выбранного дня — сегодня по Москве.
 */
export function resolvePaidAt(previous, paid, sentAt = null, now = new Date()) {
  if (!paid) return null
  if (sentAt) return dayStart(sentAt)
  if (previous?.paid) return previous.paidAt ?? null
  return moscowToday(now)
}

/**
 * Строки расходов к записи в базу.
 *
 * При правке услуги расходы удаляются и создаются заново, и отметка
 * «выплачено» не должна пропасть. Поэтому строку из формы сопоставляем с
 * прежним расходом услуги по id: тогда id и дата создания остаются, а дата
 * выплаты считается по resolvePaidAt. Если в строке нет paid, отметка
 * остаётся как была: фронт, не знающий про галочку, не должен её сбрасывать.
 * День выплаты можно прислать в paidAt (только вместе с paid: true).
 *
 * Чужой id (не из расходов этой услуги) и повторный id пропускаем: записать
 * его второй раз значило бы упасть на уникальном ключе.
 *
 * Устаревшая страница, открытая до обновления, шлёт строки без id и без paid.
 * Такие строки сопоставляем с ещё не занятым прежним расходом той же услуги
 * по паре «название и сумма» — иначе первое же сохранение с неё стёрло бы
 * все отметки. Строка с id или paid — уже новая форма, её по паре не ищем.
 */
export function expenseRows(expenses, previous = [], now = new Date()) {
  const incoming = expenses || []
  const before = new Map(previous.map((p) => [p.id, p]))
  const taken = new Set()
  const matched = incoming.map(() => null)

  // Сначала по id: строка, которая знает свой расход, не должна остаться без
  // него из-за того, что похожая строка без id оказалась в списке раньше.
  incoming.forEach((e, i) => {
    if (e.id && before.has(e.id) && !taken.has(e.id)) {
      matched[i] = before.get(e.id)
      taken.add(e.id)
    }
  })

  // Потом строки старой формы.
  incoming.forEach((e, i) => {
    if (e.id || e.paid !== undefined) return
    const title = e.title.trim()
    const amountCents = toCents(e.amount)
    const prev = previous.find((p) => !taken.has(p.id) && p.title === title && p.amountCents === amountCents)
    if (prev) {
      matched[i] = prev
      taken.add(prev.id)
    }
  })

  return incoming.map((e, i) => {
    const prev = matched[i]
    const paid = e.paid === undefined ? Boolean(prev?.paid) : e.paid
    return {
      ...(prev ? { id: prev.id, createdAt: prev.createdAt } : {}),
      title: e.title.trim(),
      amountCents: toCents(e.amount),
      paid,
      paidAt: resolvePaidAt(prev, paid, e.paidAt, now),
    }
  })
}
