import 'dotenv/config'

export const env = {
  port: process.env.PORT || 4000,
  databaseUrl: process.env.DATABASE_URL || '',

  jwtAccessSecret: process.env.JWT_ACCESS_SECRET || 'dev-access-secret',
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret',
  accessTokenTtl: '15m',
  // "Никогда" в вечном смысле для JWT технически не бывает (иначе украденный
  // токен нельзя было бы обесценить), но 400 дней — это фактически "выходишь
  // только по кнопке «Выйти»" для внутреннего инструмента команды.
  refreshTokenTtl: '400d',

  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  clientUrl: process.env.CLIENT_URL || 'http://localhost:5173',
  nodeEnv: process.env.NODE_ENV || 'development',

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
