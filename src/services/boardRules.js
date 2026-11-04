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

/** Попадает ли момент в период. Период null — без границ, попадает всё. */
export function inRange(value, range) {
  if (!range) return true
  const t = new Date(value).getTime()
  if (range.gte && t < range.gte.getTime()) return false
  if (range.lt && t >= range.lt.getTime()) return false
  if (range.lte && t > range.lte.getTime()) return false
  return true
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
 * висеть в октябре с «услуг не было».
 *
 * Клиент вообще без услуг виден по своим датам: с месяца начала работы и
 * дальше, пока не ушёл (месяц ухода ещё включён). Карточку только что
 * заведённого клиента без единой услуги иначе нигде не найти.
 */
export function cardVisible({ startedAt, leftAt, serviceCount, visibleCount }, range) {
  if (!range) return true
  if (visibleCount > 0) return true
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
  if (inRange(leftAt, range)) return 'left'
  const before = range.gte && new Date(leftAt).getTime() < range.gte.getTime()
  return before ? 'left' : 'active'
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

/**
 * Дата выплаты расхода после того, как отметку поставили или сняли.
 *
 * Снята — даты нет. Стоит и раньше стояла — остаётся прежняя: повторный
 * запрос или правка услуги не должны менять день, когда деньги ушли. Поставили
 * только что — сейчас.
 */
export function resolvePaidAt(previous, paid, now = new Date()) {
  if (!paid) return null
  return previous?.paid && previous.paidAt ? previous.paidAt : now
}

/**
 * Строки расходов к записи в базу.
 *
 * При правке услуги расходы удаляются и создаются заново, и отметка
 * «выплачено» не должна пропасть. Поэтому строку из формы сопоставляем с
 * прежним расходом услуги по id: тогда id и дата создания остаются, а дата
 * выплаты считается по resolvePaidAt. Если в строке нет paid, отметка
 * остаётся как была: фронт, не знающий про галочку, не должен её сбрасывать.
 *
 * Чужой id (не из расходов этой услуги) и повторный id пропускаем: записать
 * его второй раз значило бы упасть на уникальном ключе.
 */
export function expenseRows(expenses, previous = [], now = new Date()) {
  const before = new Map(previous.map((p) => [p.id, p]))
  const taken = new Set()
  return (expenses || []).map((e) => {
    const prev = e.id && before.has(e.id) && !taken.has(e.id) ? before.get(e.id) : null
    if (prev) taken.add(prev.id)
    const paid = e.paid === undefined ? Boolean(prev?.paid) : e.paid
    return {
      ...(prev ? { id: prev.id, createdAt: prev.createdAt } : {}),
      title: e.title.trim(),
      amountCents: toCents(e.amount),
      paid,
      paidAt: resolvePaidAt(prev, paid, now),
    }
  })
}
