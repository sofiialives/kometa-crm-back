import bcrypt from 'bcryptjs'
import { prisma } from '../config/prisma.js'

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL || 'yan993870@gmail.com'
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || 'admin'

async function run() {
  const existing = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } })
  if (existing) {
    console.log('[seed] админ уже существует:', ADMIN_EMAIL)
  } else {
    const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10)
    await prisma.user.create({
      data: { email: ADMIN_EMAIL, name: 'Админ', role: 'admin', status: 'active', active: true, passwordHash },
    })
    console.log('[seed] создан первый админ:', ADMIN_EMAIL, '/', ADMIN_PASSWORD)
  }
  await prisma.$disconnect()
}

run().catch((err) => {
  console.error('[seed] ошибка:', err)
  process.exit(1)
})
