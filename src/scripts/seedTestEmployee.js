import 'dotenv/config'
import { prisma } from '../config/prisma.js'

/**
 * Локальный тестовый сотрудник для проверки бота через fakeTelegram.js —
 * без пароля (в CRM через веб он не входит, только пишет боту) и без
 * прохода через реальный код-приглашение /start <code>: телеграм уже
 * «привязан» сразу, как будто сотрудник этот код уже ввёл.
 *
 * НЕ для продакшена: обычного сотрудника всегда привязывают через
 * реальный /start <code> (см. src/bot/updates.js) — так владелец видит,
 * кто именно привязал аккаунт, а не создаёт привязку за него.
 */
const EMAIL = process.env.SEED_EMPLOYEE_EMAIL || 'test.employee@local.test'
const NAME = process.env.SEED_EMPLOYEE_NAME || 'Тестовый сотрудник'
const CHAT_ID = process.env.SEED_EMPLOYEE_CHAT_ID || '725100934'
const ROLE = process.env.SEED_EMPLOYEE_ROLE === 'lead' ? 'lead' : 'staff'

async function run() {
  // Если этот chatId уже привязан к кому-то другому — сначала отвяжем,
  // так же как это делает реальный /start при повторной привязке.
  await prisma.telegramLink.updateMany({
    where: { chatId: CHAT_ID },
    data: { chatId: null, username: null, linkedAt: null },
  })

  let user = await prisma.user.findUnique({ where: { email: EMAIL } })
  if (!user) {
    user = await prisma.user.create({
      data: { email: EMAIL, name: NAME, role: ROLE, status: 'active', active: true },
    })
    console.log('[seed] создан тестовый сотрудник:', EMAIL, `(роль ${ROLE})`)
  } else {
    console.log('[seed] тестовый сотрудник уже существует:', EMAIL)
  }

  await prisma.telegramLink.upsert({
    where: { userId: user.id },
    create: { userId: user.id, chatId: CHAT_ID, username: 'test_employee', linkedAt: new Date() },
    update: { chatId: CHAT_ID, username: 'test_employee', linkedAt: new Date(), code: null, codeExpiresAt: null },
  })
  console.log('[seed] телеграм привязан: chatId', CHAT_ID, '→', EMAIL)
  console.log('[seed] теперь можно слать от его имени через fakeTelegram.js: POST /_say { "chatId": "' + CHAT_ID + '", "text": "..." }')

  await prisma.$disconnect()
}

run().catch((err) => {
  console.error('[seed] ошибка:', err)
  process.exit(1)
})
