import { prisma } from '../config/prisma.js'

/**
 * Ищет клиентов, которые для человека один и тот же, а для базы разные.
 *
 * Ничего не меняет — только показывает. Сливать таких нельзя автоматически:
 * к каждому могут быть привязаны работы, задачи, архив и карточка на доске,
 * и решать, какой из них настоящий, должен человек.
 *
 * Запуск (в Render → Shell):
 *   npm run clients:duplicates
 */

/** Отбрасываем всё, что человек не считает разницей: регистр, пробелы, знаки. */
const squash = (name) =>
  String(name)
    .toLowerCase()
    .replace(/[\s ]+/g, '')
    .replace(/[!?.,;:«»"'`’\-–—_()]+/g, '')

async function run() {
  const clients = await prisma.client.findMany({
    orderBy: { name: 'asc' },
    include: {
      _count: { select: { works: true } },
      archive: { select: { id: true } },
      board: { select: { id: true } },
    },
  })

  console.log(`Клиентов в базе: ${clients.length}\n`)

  const groups = new Map()
  for (const c of clients) {
    const key = squash(c.name)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(c)
  }

  const dups = [...groups.values()].filter((g) => g.length > 1)
  if (dups.length === 0) {
    console.log('Похожих имён не нашлось — дублей нет.')
  } else {
    console.log(`Похоже на дубли: ${dups.length} групп\n`)
    for (const group of dups) {
      console.log('  ─────')
      for (const c of group) {
        const where = []
        if (c._count.works) where.push(`работ: ${c._count.works}`)
        if (c.archive) where.push('есть в архиве')
        if (c.board) where.push('есть на доске')
        console.log(`  «${c.name}»  ${where.length ? '— ' + where.join(', ') : '— нигде не используется'}`)
      }
    }
    console.log('\n  Пустые можно удалить в Админ-панели. Если используются оба —')
    console.log('  перенесите работы на одного и удалите второй.')
  }

  const spaced = clients.filter((c) => c.name !== c.name.trim())
  if (spaced.length) {
    console.log(`\nИмена с пробелами по краям: ${spaced.length}`)
    for (const c of spaced) console.log(`  «${c.name}»`)
  }
}

run()
  .catch((e) => { console.error('Не получилось:', e.message); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
