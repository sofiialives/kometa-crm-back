/**
 * Разбор того, что человек пишет боту обычным текстом, — без ИИ, простыми
 * правилами. Понимает «отхожу на час», «буду через 20 минут», «вернусь в
 * 16:30», «вернулся», «задерживаюсь до 17», «форс-мажор». Чего не понял —
 * возвращает null, и бот предлагает кнопки. Когда подключим Claude, он
 * возьмёт на себя всё, что сюда не попало.
 */

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000
const MAX_BREAK_MIN = 8 * 60

const normalize = (text) => String(text ?? '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim()

const WORD_NUMBERS = {
  один: 1, одну: 1, одна: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5, десять: 10,
  пятнадцать: 15, двадцать: 20, тридцать: 30, сорок: 40, пятьдесят: 50,
}

const BACK = /(^|\s)(вернулся|вернулась|я тут|я здесь|я на месте|на месте|снова в работе|я в работе|вернул(ся|ась) в работу)(\s|[.!,]|$)/
// Форс-мажор — только явные слова: «температура спала» или «заболела
// голова, но работаю» — не повод слать Яну заявку.
const FORCE = /(форс[\s-]?мажор|форсмажор|больничн|(^|\s)заболел(а)?(\s|[.!,]|$)(?!.*(голов|работаю)))/
// «Ухожу домой», «на сегодня всё» — конец дня, а не отлучка. Только явные
// фразы: «сделаю до завтра» или «заеду домой, потом на созвон» — не уход.
// «На сегодня всё» — только целиком: «на сегодня все задачи закрыл» — отчёт, а не уход.
const DAY_END = /((ухожу|иду|еду|пошел|пошла|ушел|ушла) домой|на сегодня все\s*([.!,)]|$)|на сегодня закончил(а)?\s*([.!,)]|$)|рабочий день законч|всем пока|всем до завтра|ушел на сегодня|ушла на сегодня)/
// …но «ухожу домой на обед, вернусь в 14» — это отлучка.
const COMING_BACK = /(обед|вернусь|буду|через|перерыв)/
// Явный уход глаголом — сильнее «не успеваю»: «не успеваю закончить,
// отхожу на час» — отлучка. «Обед» и «перерыв» — слабее «вернулся»:
// «вернулся с перерыва» — это возвращение.
const AWAY_STRONG = /(отхожу|отойду|отлучусь|отлучаюсь|отъеду|отъезжаю)/
const AWAY = /(ухожу|уйду|ушел|ушла|буду через|вернусь|на обед|перерыв)/
// «Напомни мне в 15:00 позвонить клиенту» — просьба о напоминании.
const REMIND = /(^|\s)напомни(те|ть)?(\s|[,!:]|$)/
const LATE = /(задерживаюсь|задержусь|опаздываю|опоздаю|не успеваю|не успею|позже начну|начну позже)/

/** «16:30» по Москве сегодня (или через days дней), null — если уже прошло. */
function atToday(hours, minutes, now, days = 0) {
  if (hours > 23 || minutes > 59) return null
  const msk = new Date(new Date(now).getTime() + MSK_OFFSET_MS)
  const target = Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth(), msk.getUTCDate() + days, hours, minutes) - MSK_OFFSET_MS
  return target > new Date(now).getTime() ? new Date(target) : null
}

function amount(raw) {
  if (!raw) return 1
  const n = Number(String(raw).replace(',', '.'))
  if (!Number.isNaN(n)) return n
  return WORD_NUMBERS[raw] ?? null
}

/** Сообщение — это только время: «до 16:30», «к 17», «16:30». */
export function isBareTime(text) {
  return /^(до|к|в|около)?\s*\d{1,2}([:.]\d{2})?\s*$/.test(normalize(text))
}

/**
 * До какого времени: «в 16:30», «до 17», «к 17:00», «на 30 минут», «через
 * 20 мин», «на полчаса», «на полтора часа», «на 2 часа». Возвращает Date или
 * null, если время не названо или уже прошло.
 */
const CLOCK = /(?:^|\s)(?:в|до|к|около)\s+(\d{1,2})(?:[:.](\d{2}))?(?:\s*(?:час|ч)\w*)?(?:\s|[.!,]|$)/

export function parseUntil(text, now = new Date()) {
  const t = normalize(text)
  const clock = CLOCK.exec(t)
  if (clock) return atToday(Number(clock[1]), Number(clock[2] ?? 0), now)

  const base = new Date(now).getTime()
  if (/полчаса/.test(t)) return new Date(base + 30 * 60000)
  if (/полтора час/.test(t)) return new Date(base + 90 * 60000)
  // Единица — целым словом: иначе «на месте» читалось бы как «на 1 минуту».
  const span = /(?:на|через)\s+(\d+(?:[.,]\d+)?|[а-я]+)?\s*(часов|часа|час|ч|минуты|минуту|минут|мин|м)(?=\s|[.,!?)]|$)/.exec(t)
  if (span) {
    const n = amount(span[1])
    if (!n || n <= 0) return null
    const minutes = span[2].startsWith('ч') ? n * 60 : n
    if (minutes > MAX_BREAK_MIN) return null
    return new Date(base + Math.round(minutes) * 60000)
  }
  return null
}

/**
 * Что человек хочет сказать. Возвращает { type, until } или null.
 * type: back — вернулся; force_majeure — форс-мажор; away — отходит;
 * late — задерживается (с задачей или после отлучки); day_end — ушёл
 * домой, на сегодня всё; remind — просит напомнить о чём-то.
 */
export function parseIntent(text, now = new Date()) {
  const t = normalize(text)
  if (!t) return null
  if (REMIND.test(t)) return { type: 'remind', ...parseRemindAt(t, now) }
  if (FORCE.test(t)) return { type: 'force_majeure', until: parseUntil(t, now) }
  if (AWAY_STRONG.test(t)) return { type: 'away', until: parseUntil(t, now) }
  if (LATE.test(t)) return { type: 'late', until: parseUntil(t, now) }
  if (DAY_END.test(t) && !COMING_BACK.test(t)) return { type: 'day_end' }
  if (BACK.test(t)) {
    // «Буду на месте в 16:30» — это не «вернулся», а «вернусь в 16:30».
    const until = parseUntil(t, now)
    return until ? { type: 'away', until } : { type: 'back' }
  }
  if (AWAY.test(t)) return { type: 'away', until: parseUntil(t, now) }
  return null
}

const TOMORROW = /(^|\s)завтра(\s|[.!,]|$)/
// Дальше завтрашнего дня бот не напоминает — честно об этом говорим.
const FAR_DAY = /(послезавтра|понедельник|вторник|в среду|четверг|пятниц|суббот|воскресень|через (\d+ |[а-я]+ )?(дн|ден|недел|месяц))/

/**
 * Когда напомнить: { until, tomorrow, far }. «В 9» вечером — это завтра в 9
 * (сегодняшнее уже прошло). «Завтра в 10» — завтра. «Завтра» без времени —
 * tomorrow: true, бот спросит время. «В пятницу», «через неделю» — far: true.
 * tomorrow в opts — человек уже сказал «завтра», теперь отвечает временем.
 */
export function parseRemindAt(text, now = new Date(), opts = {}) {
  const t = normalize(text)
  if (FAR_DAY.test(t)) return { until: null, tomorrow: false, far: true }
  const tomorrow = Boolean(opts.tomorrow) || TOMORROW.test(t)
  const clock = CLOCK.exec(t) || (isBareTime(t) ? /(\d{1,2})(?:[:.](\d{2}))?/.exec(t) : null)
  if (clock) {
    const [h, m] = [Number(clock[1]), Number(clock[2] ?? 0)]
    const until = tomorrow ? atToday(h, m, now, 1) : atToday(h, m, now) ?? atToday(h, m, now, 1)
    return { until, tomorrow, far: false }
  }
  if (tomorrow) return { until: null, tomorrow: true, far: false }
  return { until: parseUntil(t, now), tomorrow: false, far: false }
}

// Руководитель говорит о людях: «спроси отдел, как дела», «что по задачам
// у ребят». Такое — агенту, а не правилам про свои отлучки и списки.
const TEAM_WORDS = /(отдел|команд|ребят|всем\b|всех\b|сотрудник|людям|людей|спец(ам|ов|ы)\b|опрос|пропинг|напиши|спроси|узнай|передай|поручи|табличк|таблиц|документ)/i

export function teamRequest(text) {
  return TEAM_WORDS.test(String(text ?? ''))
}

