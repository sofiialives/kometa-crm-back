import { prisma } from '../config/prisma.js'
import { chargeOverdue } from '../services/motivation/autoTasks.service.js'
import { mskDayStart } from '../services/motivation/taskRules.js'

/**
 * То же самое, что делает ночная джоба (clearFinishedTasks.job.js), но
 * запускается вручную прямо сейчас, а не ждёт следующей полночи по МСК.
 * Нужен разово — например, если код с фиксом встал на сервер уже после
 * того, как сегодняшняя ночная чистка прошла мимо (см. время деплоя).
 *
 * Запуск (в Render → Shell):
 *   npm run clear:manual
 *
 * Логика как в кроне: считает в копилку UserTaskStat ПЕРЕД удалением,
 * чистит только origin:'personal' и не трогает задачи админа — Иерархию и
 * личный дневник админа не задевает.
 *
 * Как и крон, сначала ставит штрафы мотивации за просрочку. Просроченные
 * удаляет только те, чей срок прошёл до последней полуночи по МСК: их ночной
 * штраф уже разобран. Просроченные сегодня остаются до ночи — иначе ручная
 * чистка днём уводила бы их от штрафа.
 */
async function bumpStat(field, tasks) {
  const byUser = {}
  for (const t of tasks) byUser[t.ownerId] = (byUser[t.ownerId] || 0) + 1

  for (const [userId, count] of Object.entries(byUser)) {
    await prisma.userTaskStat.upsert({
      where: { userId },
      create: { userId, [field]: count },
      update: { [field]: { increment: count } },
    })
  }
}

async function run() {
  const doneTasks = await prisma.task.findMany({
    where: { status: 'done', origin: 'personal', owner: { role: { not: 'admin' } } },
    select: { ownerId: true, title: true },
  })
  console.log(`[ручная чистка] найдено готовых: ${doneTasks.length}`)
  for (const t of doneTasks) console.log(`  - "${t.title}"`)
  await bumpStat('doneCount', doneTasks)

  const doneRes = await prisma.task.deleteMany({
    where: { status: 'done', origin: 'personal', owner: { role: { not: 'admin' } } },
  })
  console.log(`[ручная чистка] удалено готовых: ${doneRes.count}`)

  const { charged, failed } = await chargeOverdue(new Date())
  console.log(`[ручная чистка] штрафов мотивации за просрочку: ${charged}`)

  const overdueWhere = {
    status: { not: 'done' },
    deadline: { lt: mskDayStart(new Date()) },
    origin: 'personal',
    owner: { role: { not: 'admin' } },
    ...(failed.length ? { id: { notIn: failed } } : {}),
  }
  const overdueTasks = await prisma.task.findMany({
    where: overdueWhere,
    select: { ownerId: true, title: true },
  })
  console.log(`[ручная чистка] найдено просроченных: ${overdueTasks.length}`)
  for (const t of overdueTasks) console.log(`  - "${t.title}"`)
  await bumpStat('overdueCount', overdueTasks)

  const overdueRes = await prisma.task.deleteMany({ where: overdueWhere })
  console.log(`[ручная чистка] удалено просроченных: ${overdueRes.count}`)

  console.log('[ручная чистка] готово — копилка UserTaskStat пополнена, задачи удалены')
  await prisma.$disconnect()
}

run().catch((err) => {
  console.error('[ручная чистка] ошибка:', err)
  process.exit(1)
})
