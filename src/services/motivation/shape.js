/**
 * Как записи журналов уходят на фронт. Одно место на все экраны: история
 * в «Моей мотивации», карточка сотрудника у руководителя и таблица команды
 * показывают одни и те же поля одинаково.
 */

/**
 * Кто сделал запись: только имя. Почту не отдаём — историю видит и сам
 * сотрудник, а почты руководителей и админа ему знать незачем. Так же
 * устроен справочник сотрудников CRM: имя, аватар и отдел, без личных данных.
 */
export function person(user) {
  if (!user) return null
  return { id: user.id, name: user.name || 'Без имени' }
}

export function employeeCard(user) {
  return {
    id: user.id,
    name: user.name || user.email,
    email: user.email,
    // Роль нужна, чтобы в таблице владельца руководители отличались от
    // сотрудников: банк есть у тех и у других.
    role: user.role,
    position: user.position,
    active: user.active,
    avatarUrl: user.avatarUrl,
    avatarColor: user.avatarColor,
    department: user.department ? { id: user.department.id, name: user.department.name } : null,
  }
}

export function profileCard(profile) {
  if (!profile) return null
  return { id: profile.id, title: profile.title, conditionsUpdatedAt: profile.conditionsUpdatedAt }
}

const after = (date, mark) => Boolean(mark) && new Date(date).getTime() > new Date(mark).getTime()

/** Запись журнала банка. isNew — пополнение или списание, которого сотрудник ещё не видел. */
export function bankEntry(entry, seenAt) {
  return {
    id: entry.id,
    kind: entry.kind,
    reason: entry.reason,
    amountCents: entry.amountCents,
    client: entry.clientId || entry.clientName ? { id: entry.clientId, name: entry.clientName } : null,
    comment: entry.comment,
    occurredAt: entry.occurredAt,
    createdAt: entry.createdAt,
    createdBy: person(entry.createdBy),
    isNew: seenAt !== undefined && entry.kind !== 'start' && (seenAt === null || after(entry.createdAt, seenAt)),
  }
}

/** Запись журнала событий. Отменённая несёт, кто, когда и почему отменил. */
export function eventEntry(event, seenAt) {
  return {
    id: event.id,
    kind: event.kind,
    mode: event.mode,
    title: event.title,
    prizePoints: event.prizePoints,
    levelPoints: event.levelPoints,
    task: event.taskId || event.taskTitle ? { id: event.taskId, title: event.taskTitle } : null,
    client: event.clientId || event.clientName ? { id: event.clientId, name: event.clientName } : null,
    comment: event.comment,
    occurredAt: event.occurredAt,
    createdAt: event.createdAt,
    createdBy: person(event.createdBy),
    cancelled: event.cancelledAt
      ? { at: event.cancelledAt, by: person(event.cancelledBy), reason: event.cancelReason }
      : null,
    isNew: seenAt !== undefined && !event.cancelledAt && (seenAt === null || after(event.createdAt, seenAt)),
  }
}

/** Новые сверху: так история читается в ленте у сотрудника. */
export function newestFirst(list) {
  return [...list].sort((a, b) =>
    new Date(b.occurredAt) - new Date(a.occurredAt) || new Date(b.createdAt) - new Date(a.createdAt))
}

/**
 * Событие профиля в «Моих условиях» и в формах. Заработок или штраф
 * решает знак баллов в премию; если там ноль, смотрим баллы в уровень.
 */
export function eventTypeCard(type) {
  const sign = type.prizePoints !== 0 ? Math.sign(type.prizePoints) : Math.sign(type.levelPoints)
  return {
    id: type.id,
    title: type.title,
    example: type.example,
    prizePoints: type.prizePoints,
    levelPoints: type.levelPoints,
    mode: type.mode,
    autoRule: type.autoRule,
    systemKey: type.systemKey,
    enabled: type.enabled,
    position: type.position,
    isPenalty: sign < 0,
  }
}
