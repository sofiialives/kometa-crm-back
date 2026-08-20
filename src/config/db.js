import { prisma } from './prisma.js'

export async function connectDb() {
  await prisma.$connect()
  console.log('[db] подключено (PostgreSQL через Prisma)')
}
