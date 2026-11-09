import 'dotenv/config'
import bcrypt from 'bcryptjs'
import { prisma } from '../config/prisma.js'

/**
 * Три локальных тестовых аккаунта с уже «привязанным» телеграмом и сразу
 * заведённым тестовым отделом (сотрудник 1 — его руководитель, сотрудник
 * 2 — обычный участник), чтобы
 * не проходить код-приглашение /start <code> (см. src/bot/updates.js)
 * заново для каждого. Подходит и для fakeTelegram.js, и для настоящего
 * бота: если у вас уже настоящий TELEGRAM_BOT_TOKEN в .env, просто
 * подставьте chatId ваших реальных телеграм-аккаунтов через переменные
 * окружения — тогда писать боту можно прямо из вашего телеграма, без
 * fakeTelegram.js вообще:
 *
 *   SEED_ADMIN_CHAT_ID=... SEED_STAFF1_CHAT_ID=... SEED_STAFF2_CHAT_ID=... \
 *   SEED_ADMIN_PASSWORD=любой_пароль node src/scripts/seedLocalTesters.js
 *
 * Без этих переменных используются условные id для fakeTelegram.js.
 * Узнать свой chatId проще всего через @userinfobot в телеграме, либо
 * написав разок настоящему боту и посмотрев chatId входящего апдейта в
 * логах backend (startPolling в src/bot/updates.js печатает апдейты).
 *
 * НЕ для продакшена: обычного человека всегда привязывают через реальный
 * /start <code> — так видно, кто именно привязал аккаунт, а не создаёт
 * привязку за него.
 *
 * Если SEED_ADMIN_PASSWORD не задан, тестовому админу просто не ставится
 * пароль — войти в веб-CRM под ним не получится, но бот и доступ к
 * «Мотивации» через API под его токеном всё равно работают.
 */
const PEOPLE = [
  { role: 'admin', email: 'test.admin@local.test', name: 'Тестовый админ', chatId: process.env.SEED_ADMIN_CHAT_ID || '725100934' },
  // Роль lead — чтобы сразу можно было проверить бонус руководителю за
  // клиента, закрытого в срок (client_closed_on_time): ниже этого
  // человека назначают руководителем тестового отдела.
  { role: 'lead', email: 'test.staff1@local.test', name: 'Тестовый сотрудник 1', chatId: process.env.SEED_STAFF1_CHAT_ID || '7966249559' },
  { role: 'staff', email: 'test.staff2@local.test', name: 'Тестовый сотрудник 2', chatId: process.env.SEED_STAFF2_CHAT_ID || '8926534835' },
]

const DEPARTMENT_NAME = process.env.SEED_DEPARTMENT_NAME || 'Тестовый отдел'

/**
 * Тестовый отдел с обоими не-админами внутри и первым из них —
 * руководителем. Без отдела в CRM нечего открыть на вкладке «Иерархия»:
 * клиентов, работы и задачи заводят внутри отдела, а бонус руководителю
 * (пункт 7 правок) проверяется именно через leadId этого отдела.
 */
async function ensureDepartment(leadUser, memberIds) {
  let department = await prisma.department.findUnique({ where: { name: DEPARTMENT_NAME } })
  if (!department) {
    department = await prisma.department.create({ data: { name: DEPARTMENT_NAME, leadId: leadUser.id } })
    console.log('[seed] создан отдел:', DEPARTMENT_NAME, '— руководитель', leadUser.email)
  } else if (department.leadId !== leadUser.id) {
    department = await prisma.department.update({ where: { id: department.id }, data: { leadId: leadUser.id } })
    console.log('[seed] отдел уже был, руководитель переставлен на', leadUser.email)
  } else {
    console.log('[seed] отдел уже существует:', DEPARTMENT_NAME)
  }
  await prisma.user.updateMany({ where: { id: { in: memberIds } }, data: { departmentId: department.id } })
  console.log('[seed] в отдел включены:', memberIds.length, 'человек(а)')
  return department
}

async function linkTelegram(userId, chatId) {
  // Если этот chatId уже привязан к кому-то другому — сначала отвяжем,
  // так же как это делает реальный /start при повторной привязке.
  await prisma.telegramLink.updateMany({
    where: { chatId, userId: { not: userId } },
    data: { chatId: null, username: null, linkedAt: null },
  })
  await prisma.telegramLink.upsert({
    where: { userId },
    create: { userId, chatId, username: `local_${chatId}`, linkedAt: new Date() },
    update: { chatId, username: `local_${chatId}`, linkedAt: new Date(), code: null, codeExpiresAt: null },
  })
}

async function run() {
  const users = {}
  for (const p of PEOPLE) {
    let user = await prisma.user.findUnique({ where: { email: p.email } })
    if (!user) {
      const data = { email: p.email, name: p.name, role: p.role, status: 'active', active: true }
      if (p.role === 'admin' && process.env.SEED_ADMIN_PASSWORD) {
        data.passwordHash = await bcrypt.hash(process.env.SEED_ADMIN_PASSWORD, 10)
      }
      user = await prisma.user.create({ data })
      console.log(`[seed] создан ${p.role === 'admin' ? 'тестовый админ' : 'тестовый ' + p.role}:`, p.email)
    } else if (user.role !== p.role) {
      user = await prisma.user.update({ where: { id: user.id }, data: { role: p.role } })
      console.log('[seed] уже существует, роль поставлена', p.role + ':', p.email)
    } else {
      console.log('[seed] уже существует:', p.email)
    }
    await linkTelegram(user.id, p.chatId)
    console.log('[seed] телеграм привязан: chatId', p.chatId, '→', p.email)
    users[p.email] = user
  }

  await ensureDepartment(
    users['test.staff1@local.test'],
    [users['test.staff1@local.test'].id, users['test.staff2@local.test'].id],
  )

  console.log('[seed] готово. Если chatId реальные — пишите боту прямо из телеграма; для fakeTelegram.js — POST /_say { "chatId": "...", "text": "..." }')
  await prisma.$disconnect()
}

run().catch((err) => {
  console.error('[seed] ошибка:', err)
  process.exit(1)
})
