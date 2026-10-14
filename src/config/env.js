import 'dotenv/config'

const nodeEnv = process.env.NODE_ENV || 'development'
// Регистр и пробелы не важны: «Production» в панели — тоже боевой сервер,
// и пустить его на временных секретах хуже, чем не стартовать.
const isProduction = nodeEnv.trim().toLowerCase() === 'production'

// Секрет для подписи токенов входа. В разработке можно не задавать —
// подставится временное значение. На боевом сервере без него не стартуем:
// временные значения лежат в открытом коде, и по ним кто угодно подделает
// токен и войдёт в CRM под любым сотрудником.
function jwtSecret(name, devFallback) {
  const value = process.env[name]
  // Строка из одних пробелов — тоже «не задано». Сам секрет не обрезаем,
  // чтобы уже выданные токены остались действительными.
  if (value && value.trim()) return value
  if (isProduction) {
    throw new Error(
      `Не задана переменная окружения ${name}. На боевом сервере она обязательна: ` +
        'без неё токены входа подписывались бы общеизвестным ключом. ' +
        'Задайте её в панели Render и перезапустите сервис.',
    )
  }
  return devFallback
}

// Адрес API телеграма. Токен уходит в путь запроса, поэтому подменить адрес
// можно только локально и только на свою машину. На боевом сервере —
// всегда настоящий телеграм: чужой адрес получил бы токен и мог бы слать
// боту поддельные нажатия кнопок.
const TELEGRAM_API = 'https://api.telegram.org/bot'
function telegramApiBase() {
  const value = (process.env.TELEGRAM_API_BASE || '').trim()
  if (!value || value === TELEGRAM_API) return TELEGRAM_API
  if (!isProduction && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(value)) return value
  console.error('[бот] TELEGRAM_API_BASE не принят: на боевом сервере и для чужих адресов — только api.telegram.org')
  return TELEGRAM_API
}

export const env = {
  port: process.env.PORT || 4000,
  databaseUrl: process.env.DATABASE_URL || '',

  jwtAccessSecret: jwtSecret('JWT_ACCESS_SECRET', 'dev-access-secret'),
  jwtRefreshSecret: jwtSecret('JWT_REFRESH_SECRET', 'dev-refresh-secret'),
  accessTokenTtl: '15m',
  // "Никогда" в вечном смысле для JWT технически не бывает (иначе украденный
  // токен нельзя было бы обесценить), но 400 дней — это фактически "выходишь
  // только по кнопке «Выйти»" для внутреннего инструмента команды.
  refreshTokenTtl: '400d',

  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  clientUrl: process.env.CLIENT_URL || 'http://localhost:5173',
  nodeEnv,

  // Имя бота напоминаний — нужно, чтобы собрать ссылку вида
  // t.me/<бот>?start=<код>. Не секрет: его и так видно в телеграме.
  // Значение по умолчанию — чтобы кнопка в настройках заработала сразу
  // после выката, без отдельного похода в переменные окружения. Сменится
  // бот — переопределяется переменной, код трогать не нужно.
  telegramBotUsername: process.env.TELEGRAM_BOT_USERNAME || 'kometa_agent_bot',

  // Токен бота напоминаний. Пока не задан, бот просто не запускается —
  // остальной сервер работает как обычно. Так локальная разработка и
  // любое окружение без токена не падают на старте.
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',

  // Адрес API телеграма. Меняют только для проверки на поддельном
  // телеграме (src/scripts/fakeTelegram.js) — боевой токен локально не нужен.
  telegramApiBase: telegramApiBase(),

  // ИИ в боте (Claude). Пока ключа нет, бот работает по своим правилам,
  // как раньше. Модель и общий дневной потолок запросов можно поменять
  // переменными, не трогая код.
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  aiModel: process.env.AI_MODEL || 'claude-haiku-5-5',
  aiDailyCap: Number(process.env.AI_DAILY_CAP) || 600,

  // За сколько минут до звонка предупреждать.
  remindBeforeMin: Number(process.env.REMIND_BEFORE_MIN) || 15,

  // Хранилище файлов для Архива — Cloudflare R2. Совместимо с S3, поэтому
  // берётся обычным AWS SDK, только адрес свой.
  //
  // Пока ключи не заданы, вкладка Архива работает на чтение, а загрузка
  // отвечает понятной ошибкой вместо падения. Так локальная разработка не
  // требует ни аккаунта, ни ключей.
  r2: {
    accountId: process.env.R2_ACCOUNT_ID || '',
    accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
    bucket: process.env.R2_BUCKET || '',
  },

  // Потолок на один отчёт. 20 МБ — с запасом для PDF с картинками, и при
  // этом файл целиком помещается в память сервера (на Render её 512 МБ).
  maxReportBytes: Number(process.env.MAX_REPORT_BYTES) || 20 * 1024 * 1024,

  smtp: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT) || 587,
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || 'KOMETA CRM <no-reply@kometa.web3>',
  },
}
