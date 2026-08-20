import 'dotenv/config'

export const env = {
  port: process.env.PORT || 4000,
  databaseUrl: process.env.DATABASE_URL || '',

  jwtAccessSecret: process.env.JWT_ACCESS_SECRET || 'dev-access-secret',
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret',
  accessTokenTtl: '15m',
  refreshTokenTtl: '30d',

  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  clientUrl: process.env.CLIENT_URL || 'http://localhost:5173',
  nodeEnv: process.env.NODE_ENV || 'development',

  smtp: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT) || 587,
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || 'KOMETA CRM <no-reply@kometa.web3>',
  },
}
