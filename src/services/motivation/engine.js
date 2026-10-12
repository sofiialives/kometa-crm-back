/**
 * Расчёт мотивации за месяц: банк, баллы, суммы уровней, заработанное.
 *
 * Модуль чистый: на вход — шкала и записи журналов, на выход — готовые
 * цифры. Базы здесь нет, поэтому каждое правило проверяется тестом на
 * обычных массивах, а сервисы вокруг только достают записи и отдают ответ.
 *
 * Деньги считаются в центах целыми числами. Суммы уровней округляются до
 * целого доллара — так в задании, и так их проще читать на шкале.
 *
 * ---------------------------------------------------------------------------
 * Почему расчёт идёт «по времени», а не одной формулой
 * ---------------------------------------------------------------------------
 *
 * В задании сумма уровня — это просто «банк × доля». Но на созвоне заказчик
 * поменял правило: когда банк растёт, деньги должны идти только на уровни,
 * до которых человек ещё не дошёл. Уровень, на котором он уже стоит, от
 * пополнения не дорожает: иначе выгодно сидеть на месте и ждать, пока
 * банк вырастет сам.
 *
 * Отсюда следует, что сумма уровня зависит от того, ЧТО случилось раньше:
 * человек дошёл до третьего уровня до пополнения или после. Поэтому журналы
 * проигрываются по порядку, запись за записью, и на каждом шаге помнится,
 * на какой сумме какой уровень зафиксировался.
 *
 * Правила, о которых договорились отдельно:
 *
 *   1. Пройденный уровень фиксирует свою сумму в момент, когда человек на
 *      него вышел: банк × доля на тот момент. Следующие пополнения его не
 *      меняют, они поднимают только уровни выше.
 *
 *   2. Защита: если уровень пройден, пока банк был пуст, фиксировать
 *      нечего — ноль долларов. Такой уровень ждёт первого пополнения и
 *      фиксируется уже с ним. Иначе человек, рано набравший баллы, прошёл
 *      бы уровни зря, и в этом заказчик сам засомневался в конце созвона.
 *
 *   3. Последний уровень всегда равен всему банку, так прямо написано в
 *      задании. Он никогда не фиксируется: деньгам больше некуда идти,
 *      кроме как тому, кто уже на вершине.
 *
 *   4. Упал ниже уровня из-за штрафов — уровень снова считается
 *      непройденным и растёт с пополнениями, как у всех, кто до него не
 *      дошёл. Поднялся обратно — фиксируется заново, по новому банку.
 *
 *   5. Баллы не уходят ниже нуля и выше ста в любой момент. Штраф, пришедший
 *      при нуле, сгорает, долга нет: −10, потом +20 дают 20, а не 10.
 *
 *   6. Списание из банка (только админ, при ошибочном пополнении) не может
 *      оставить уровень дороже, чем он стоит при новом банке: зафиксированные
 *      суммы срезаются до банк × доля. Иначе высший уровень мог бы стоить
 *      меньше низшего.
 */

export const POINTS_MIN = 0
export const POINTS_MAX = 100

export function clampPoints(value) {
  return Math.min(POINTS_MAX, Math.max(POINTS_MIN, value))
}

/** Центы, округлённые до целого доллара. 3750 → 3800, 3749 → 3700. */
export function roundToDollar(cents) {
  return Math.round(cents / 100) * 100
}

/** Сумма уровня при данном банке: банк × доля, до целого доллара. */
export function levelAmount(bankCents, percent) {
  return roundToDollar((bankCents * percent) / 100)
}

/** Уровни по возрастанию порога. Копия: исходный массив не трогаем. */
export function sortLevels(levels) {
  return [...levels].sort((a, b) => a.threshold - b.threshold || (a.position ?? 0) - (b.position ?? 0))
}

/**
 * Проверка шкалы премии перед сохранением. Возвращает список понятных
 * ошибок, пустой — значит шкала годится.
 *
 * Пороги и доли строго растут: уровень выше не может требовать меньше
 * баллов или давать меньшую долю. Последний уровень — весь банк.
 */
export function validateScale(levels) {
  const errors = []
  if (!Array.isArray(levels) || levels.length === 0) {
    return ['В шкале должен быть хотя бы один уровень']
  }
  if (levels.length > 10) errors.push('Уровней не может быть больше десяти')

  levels.forEach((l, i) => {
    const n = i + 1
    if (!Number.isInteger(l.threshold) || l.threshold < 1 || l.threshold > POINTS_MAX) {
      errors.push(`Уровень ${n}: порог должен быть целым числом от 1 до ${POINTS_MAX}`)
    }
    if (!Number.isInteger(l.percent) || l.percent < 1 || l.percent > 100) {
      errors.push(`Уровень ${n}: доля банка должна быть целым числом от 1 до 100`)
    }
    if (i > 0) {
      const prev = levels[i - 1]
      if (l.threshold <= prev.threshold) errors.push(`Уровень ${n}: порог должен быть больше, чем у уровня ${n - 1}`)
      if (l.percent <= prev.percent) errors.push(`Уровень ${n}: доля должна быть больше, чем у уровня ${n - 1}`)
    }
  })

  const last = levels[levels.length - 1]
  if (last && last.percent !== 100) errors.push('Последний уровень всегда забирает весь банк: его доля — 100%')

  return errors
}

/**
 * Проверка уровней работы. Первый начинается с нуля, следующие строго
 * выше: между уровнями не должно быть дыр, иначе на каких-то баллах
 * человек остался бы вообще без уровня.
 */
export function validateWorkLevels(levels) {
  const errors = []
  if (!Array.isArray(levels) || levels.length === 0) {
    return ['Нужен хотя бы один уровень работы']
  }
  if (levels.length > 10) errors.push('Уровней работы не может быть больше десяти')
  if (levels[0] && levels[0].minPoints !== 0) errors.push('Первый уровень работы начинается с 0 баллов')

  levels.forEach((l, i) => {
    const n = i + 1
    if (!l.title || !String(l.title).trim()) errors.push(`Уровень ${n}: нужно название`)
    if (!Number.isInteger(l.minPoints) || l.minPoints < 0 || l.minPoints > POINTS_MAX) {
      errors.push(`Уровень ${n}: граница должна быть целым числом от 0 до ${POINTS_MAX}`)
    }
    if (i > 0 && l.minPoints <= levels[i - 1].minPoints) {
      errors.push(`Уровень ${n}: граница должна быть больше, чем у уровня ${n - 1}`)
    }
  })
  return errors
}

/** Сколько уровней шкалы пройдено при данном числе баллов. */
export function reachedCount(levels, points) {
  let count = 0
  for (const l of levels) {
    if (points >= l.threshold) count += 1
    else break
  }
  return count
}

/**
 * Записи двух журналов в одну ленту по времени.
 *
 * При одинаковом времени деньги идут раньше баллов: пополнение и событие в
 * одну и ту же миллисекунду — это почти всегда стартовая сумма месяца и
 * что-то, что тоже пришлось на полночь первого числа. Деньгам в таком
 * случае честнее прийти первыми. Дальше — по времени создания и по id,
 * чтобы порядок был одинаковым при любом пересчёте.
 */
export function buildTimeline(bankEntries = [], events = []) {
  const items = [
    ...bankEntries.map((e) => ({ type: 'bank', order: 0, at: time(e.occurredAt), created: time(e.createdAt ?? e.occurredAt), id: e.id ?? '', entry: e })),
    ...events
      .filter((e) => !e.cancelledAt)
      .map((e) => ({ type: 'event', order: 1, at: time(e.occurredAt), created: time(e.createdAt ?? e.occurredAt), id: e.id ?? '', entry: e })),
  ]
  items.sort((a, b) =>
    a.at - b.at
    || a.order - b.order
    || a.created - b.created
    || String(a.id).localeCompare(String(b.id)))
  return items
}

function time(value) {
  return value ? new Date(value).getTime() : 0
}

/**
 * Проигрывает месяц и возвращает состояние шкалы премии на его конец (или
 * на сейчас, если месяц текущий — тогда в журналах просто нет будущего).
 */
export function replayPrize({ levels, bankEntries = [], events = [] }) {
  const scale = sortLevels(levels)
  const lastIndex = scale.length - 1

  let bankCents = 0
  let prizePoints = 0
  let levelPoints = 0
  let reached = 0

  // Зафиксированная сумма каждого уровня или null, если уровень плавает:
  // ещё не пройден, пройден при пустом банке или это последний уровень.
  const fixed = scale.map(() => null)

  const floating = (i) => levelAmount(bankCents, scale[i].percent)

  for (const item of buildTimeline(bankEntries, events)) {
    if (item.type === 'bank') {
      const amount = Number(item.entry.amountCents) || 0
      bankCents = Math.max(0, bankCents + amount)

      if (amount > 0) {
        // Правило 2: уровни, пройденные при пустом банке, ждали денег —
        // фиксируем их первым же пополнением.
        for (let i = 0; i < reached; i += 1) {
          if (i !== lastIndex && fixed[i] === null) fixed[i] = floating(i)
        }
      } else if (amount < 0) {
        // Правило 6: после списания уровень не может стоить больше, чем при
        // новом банке.
        for (let i = 0; i < fixed.length; i += 1) {
          if (fixed[i] !== null) fixed[i] = Math.min(fixed[i], floating(i))
        }
      }
      continue
    }

    prizePoints = clampPoints(prizePoints + (Number(item.entry.prizePoints) || 0))
    levelPoints = clampPoints(levelPoints + (Number(item.entry.levelPoints) || 0))

    const now = reachedCount(scale, prizePoints)
    if (now > reached) {
      // Правило 1: вышел на новые уровни — их суммы фиксируются по
      // текущему банку. При пустом банке фиксировать нечего (правило 2).
      for (let i = reached; i < now; i += 1) {
        fixed[i] = i !== lastIndex && bankCents > 0 ? floating(i) : null
      }
    } else if (now < reached) {
      // Правило 4: упал ниже — уровни выше снова плавают.
      for (let i = now; i < reached; i += 1) fixed[i] = null
    }
    reached = now
  }

  const shaped = scale.map((l, i) => {
    const isLast = i === lastIndex
    const isFixed = !isLast && i < reached && fixed[i] !== null
    return {
      position: i + 1,
      threshold: l.threshold,
      percent: l.percent,
      // Правило 3: последний уровень — весь банк, всегда.
      amountCents: isLast ? roundToDollar(bankCents) : isFixed ? fixed[i] : floating(i),
      reached: i < reached,
      fixed: isFixed,
    }
  })

  const earnedCents = reached > 0 ? shaped[reached - 1].amountCents : 0
  const nextLevel = reached < shaped.length ? shaped[reached] : null

  return {
    bankCents,
    prizePoints,
    levelPoints,
    levels: shaped,
    currentLevel: reached,
    earnedCents,
    next: nextLevel
      ? {
          position: nextLevel.position,
          threshold: nextLevel.threshold,
          pointsLeft: nextLevel.threshold - prizePoints,
          amountCents: nextLevel.amountCents,
        }
      : null,
  }
}

/**
 * Уровень работы по баллам уровня. Верхняя граница каждого уровня — это
 * граница следующего минус один, у последнего — сто.
 */
export function workLevelFor(workLevels, points) {
  const sorted = [...workLevels].sort((a, b) => a.minPoints - b.minPoints)
  if (sorted.length === 0) return { current: null, next: null, pointsLeft: null, levels: [] }

  const levels = sorted.map((l, i) => ({
    position: i + 1,
    title: l.title,
    hint: l.hint,
    minPoints: l.minPoints,
    maxPoints: i < sorted.length - 1 ? sorted[i + 1].minPoints - 1 : POINTS_MAX,
  }))

  let index = 0
  levels.forEach((l, i) => {
    if (points >= l.minPoints) index = i
  })

  const current = levels[index]
  const next = levels[index + 1] ?? null
  return {
    levels,
    current: { ...current, index },
    next,
    pointsLeft: next ? next.minPoints - points : null,
  }
}

/**
 * Месяц целиком: шкала премии и уровень работы. Это то, что видит
 * сотрудник на экране «Моя мотивация» и руководитель в таблице команды.
 */
export function computeMonth({ levels, workLevels, bankEntries, events }) {
  const prize = replayPrize({ levels, bankEntries, events })
  const work = workLevelFor(workLevels, prize.levelPoints)
  return { ...prize, work }
}
