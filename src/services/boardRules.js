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
 * позади.
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
// Дни и периоды
// ---------------------------------------------------------------------------

export const DAY_MS = 24 * 60 * 60 * 1000

/** Полночь UTC того дня, на который приходится момент: дни на доске хранятся целиком. */
export function dayStart(value) {
  const d = new Date(value)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
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

// ---------------------------------------------------------------------------
// Услуги в периоде
// ---------------------------------------------------------------------------

/**
 * Месяц услуги внутри периода. Только такая услуга видна в периоде и даёт
 * выручку и расходы: деньги по ней принадлежат её месяцу. Срок работ на
 * доске ничего не решает.
 */
export function serviceInPeriod(service, range) {
  return inRange(service.month, range)
}

/**
 * Выручка, расходы, «не выплачено» и прибыль по набору услуг. Единственное
 * место, где это считается.
 *
 * Считаются только услуги, месяц которых в периоде. Без периода (null) —
 * все.
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
 * Услуга для ответа: её цифры (выручка, расходы, прибыль) и признак «месяц
 * в периоде».
 */
export function shapeService(service, range) {
  return {
    ...service,
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
 * Клиент виден, если у него есть услуга, месяц которой попадает в период.
 * Единственное исключение — уход: клиент, ушедший в этом периоде, виден в
 * нём в «Ушедших», даже если услуг в нём нет. Иначе уход потерялся бы из
 * счётчика ушедших за месяц. Дата начала работы и срок работ видимость не
 * определяют. Без периода («за всё время») видны все.
 */
export function cardVisible({ status, leftAt, serviceCount, serviceCountTotal = null, startedAt = null }, range) {
  if (!range) return true
  if (serviceCount > 0) return true
  // Только что заведённый клиент без единой услуги не пропадает с доски:
  // виден в месяце начала работ, пока ему не добавят услугу.
  if (serviceCountTotal === 0 && startedAt && inRange(monthStart(startedAt), range)) return true
  return status === 'left' && Boolean(leftAt) && inRange(leftAt, range)
}

/**
 * В какой колонке карточка в выбранном периоде: 'active' или 'left'.
 *
 * В «Ушедших» клиент, который ушёл в этом периоде или раньше. Ушёл
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
 * Доска из карточек, прочитанных из базы вместе с услугами и их расходами
 * : сводка сверху и две колонки. В карточки для периода попадают не все, а
 * сводка знает всех (см. onBoardClientIds). Что видно и в какой колонке —
 * решают правила выше, здесь они только собираются в ответ.
 */
export function buildBoard(cards, range, now = new Date()) {
  const active = []
  const left = []
  const visibleServices = []

  for (const c of cards) {
    // Услуги в карточке уже отобраны запросом по месяцу и могут быть не
    // всеми: сколько их всего, говорит счётчик.
    const serviceCount = c._count.services
    const visible = c.services.filter((s) => serviceInPeriod(s, range))
    if (!cardVisible({
      status: c.status,
      leftAt: c.leftAt,
      serviceCount: visible.length,
      serviceCountTotal: serviceCount,
      startedAt: c.startedAt,
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
      serviceCountTotal: serviceCount,
      // Сколько услуг дают деньги в периоде.
      serviceCountInPeriod: visible.length,
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
