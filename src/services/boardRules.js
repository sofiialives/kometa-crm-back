/**
 * Правила доски клиентов без базы данных — чтобы проверять их тестами.
 *
 * Здесь живёт всё, что решает «что показывать в выбранном периоде»; сервис
 * только достаёт данные из базы и отдаёт их сюда.
 */

/** Первое число месяца по UTC — к нему привязана каждая услуга. */
export function monthStart(value) {
  const d = new Date(value)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
}

/**
 * Границы выбранного периода.
 *
 * Возвращает null для режима «за всё время» — тогда фильтра по месяцу нет
 * вовсе.
 *
 * В режиме произвольного периода услуга попадает в выборку, если первое
 * число её месяца лежит в заданном диапазоне. Границы при этом НЕ округляем
 * до месяца: округление наружу превратило бы «последние 90 дней» в четыре
 * месяца вместо трёх, и сводка показала бы больше, чем есть.
 *
 * Следствие: данные помесячные, половинок месяца не бывает. «С 15 сентября»
 * сентябрь уже не захватит — его первое число осталось позади.
 */
export function resolveRange({ mode, month, months, from, to }) {
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
  if (mode === 'last') {
    const now = new Date()
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1))
    return { gte: start, lte: now }
  }

  const range = {}
  if (from) range.gte = new Date(from)
  if (to) range.lte = new Date(to)
  return Object.keys(range).length ? range : null
}
