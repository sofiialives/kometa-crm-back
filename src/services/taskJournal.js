import { prisma } from '../config/prisma.js'

/**
 * Действия с задачами — в журнал сотрудника (вкладка «Журнал бота»):
 * поставил задачу, взял в работу, закрыл (в срок или нет), вернул из
 * «Готово», продлил срок. По ним Ян видит, кто что делал, — и замечает,
 * если кто-то двигает сроки, чтобы не попасть в просрочку.
 *
 * Сбой записи задачу не трогает: журнал — не повод отказать в действии.
 */
export function logTaskEvent(userId, type, task, extra = {}, at = new Date()) {
  return prisma.botEvent.create({
    data: {
      userId,
      type,
      at,
      data: { taskId: task.id, taskTitle: String(task.title ?? '').slice(0, 200), origin: task.origin ?? null, ...extra },
    },
  }).catch((e) => {
    console.error('[журнал] задача:', e.message)
    return null
  })
}
