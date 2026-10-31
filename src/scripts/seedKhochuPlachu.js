import 'dotenv/config'
import bcrypt from 'bcryptjs'
import { prisma } from '../config/prisma.js'
import { DEPARTMENT_NAME, ACCOUNT_MANAGER_POSITION, MANAGER_POSITION } from '../services/khochuPlachu.service.js'

const OTHER_DEPARTMENT_NAME = 'Тестовый отдел (другой)'
const TEST_PASSWORD = process.env.SEED_KHOCHU_PLACHU_PASSWORD || 'test12345'

const USERS = [
  { email: 'khochuplachu.admin@kometa.local', name: 'Тест Админ', role: 'admin', position: null, department: null, chatId: '725100934' },
  { email: 'khochuplachu.account@kometa.local', name: 'Тест Аккаунт-менеджер', role: 'staff', position: ACCOUNT_MANAGER_POSITION, department: DEPARTMENT_NAME, chatId: '7162857998' },
  { email: 'khochuplachu.manager@kometa.local', name: 'Тест Менеджер', role: 'staff', position: MANAGER_POSITION, department: DEPARTMENT_NAME, chatId: '8926534835' },
  { email: 'khochuplachu.outsider@kometa.local', name: 'Тест Сотрудник другого отдела', role: 'staff', position: null, department: OTHER_DEPARTMENT_NAME, chatId: '7966249559' },
]

async function run() {
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10)

  const department = await prisma.department.upsert({
    where: { name: DEPARTMENT_NAME },
    update: { positions: { set: [MANAGER_POSITION, ACCOUNT_MANAGER_POSITION] } },
    create: { name: DEPARTMENT_NAME, positions: [MANAGER_POSITION, ACCOUNT_MANAGER_POSITION] },
  })

  const otherDepartment = await prisma.department.upsert({
    where: { name: OTHER_DEPARTMENT_NAME },
    update: {},
    create: { name: OTHER_DEPARTMENT_NAME, positions: [] },
  })

  const departmentByName = { [DEPARTMENT_NAME]: department.id, [OTHER_DEPARTMENT_NAME]: otherDepartment.id }

  for (const u of USERS) {
    const departmentId = u.department ? departmentByName[u.department] : null

    const user = await prisma.user.upsert({
      where: { email: u.email },
      update: { role: u.role, position: u.position, departmentId, active: true, status: 'active' },
      create: {
        email: u.email,
        name: u.name,
        role: u.role,
        position: u.position,
        departmentId,
        status: 'active',
        active: true,
        passwordHash,
      },
    })

    await prisma.telegramLink.upsert({
      where: { userId: user.id },
      update: { chatId: u.chatId, linkedAt: new Date() },
      create: { userId: user.id, chatId: u.chatId, linkedAt: new Date() },
    })

    console.log(`[seed] готов: ${u.email} (${u.role}${u.position ? ', ' + u.position : ''}) — чат ${u.chatId}`)
  }

  console.log(`[seed] пароль для входа у всех тестовых пользователей: ${TEST_PASSWORD}`)
  await prisma.$disconnect()
}

run().catch((err) => {
  console.error('[seed] ошибка:', err)
  process.exit(1)
})
