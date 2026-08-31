import { prisma } from '../config/prisma.js'

/**
 * Разовая уборка задач, которые "утекли" из Иерархии в личный Задачник
 * ещё до того, как появилось поле origin (их работу удалили раньше —
 * восстановить, что они были из Иерархии, по обычным данным уже нельзя,
 * пришлось найти по названиям вручную).
 *
 * Запуск (в Render → Shell):
 *   npm run fix:leaked-tasks
 *
 * Ничего не спрашивает и не ломает — просто находит эти конкретные
 * задачи по точным названиям и помечает как "из Иерархии", после чего
 * они пропадают из личного Задачника у всех, а в самой Иерархии (если
 * бы там показывались) видны как обычно — ничего не удаляется.
 */
const LEAKED_TITLES = [
  'Финальная таблица',
  'Отчет по кампании для Кометы',
  'Отчет по кампании для клиента',
  'Этап размещения',
]

async function run() {
  const found = await prisma.task.findMany({
    where: { title: { in: LEAKED_TITLES }, workId: null },
    select: { id: true, title: true, ownerId: true, deadline: true },
  })

  if (found.length === 0) {
    console.log('[fix] ничего не нашлось — либо уже почищено, либо задачи называются иначе')
    await prisma.$disconnect()
    return
  }

  console.log(`[fix] нашлось ${found.length} задач:`)
  for (const t of found) {
    console.log(`  - "${t.title}" (срок: ${t.deadline.toISOString().slice(0, 10)})`)
  }

  const result = await prisma.task.updateMany({
    where: { title: { in: LEAKED_TITLES }, workId: null },
    data: { origin: 'hierarchy' },
  })

  console.log(`[fix] готово — помечено ${result.count} задач, из личного Задачника они пропадут`)
  await prisma.$disconnect()
}

run().catch((err) => {
  console.error('[fix] ошибка:', err)
  process.exit(1)
})
