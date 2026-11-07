/**
 * Что таблица «Команда» добавляет к расчёту: должность из CRM и отделы без
 * условий баллов. Чистые функции — чтобы проверять тестами без базы.
 */

/**
 * Должность человека — как её ставят в CRM (User.position), а не профиль
 * мотивации. Для закрытого месяца тоже берётся нынешняя: должность в
 * таблице — справочная, баллы она не задаёт. Нет пользователя в карте —
 * остаётся то, что лежало в снимке.
 *
 * @param {Array} rows строки таблицы (employee.id обязателен)
 * @param {Map<string, string|null>} positions id пользователя → User.position
 */
export function withPosition(rows, positions) {
  return rows.map((row) => {
    const position = (positions.has(row.employee.id) ? positions.get(row.employee.id) : row.employee.position) ?? null
    return { ...row, position, employee: { ...row.employee, position } }
  })
}

/**
 * Отделы без условий баллов: у отдела нет действующего профиля мотивации и
 * ни у кого из его людей в таблице профиля нет (старые профили без отдела
 * назначаются вручную, и такой отдел условия всё же имеет).
 *
 * @param {Array<{id: string, name: string}>} departments отделы в области просмотра
 * @param {Array<{departmentId: string|null}>} profiles действующие профили
 * @param {Array} rows строки таблицы
 * @returns {Array<{id: string, name: string}>}
 */
export function departmentsWithoutProfile(departments, profiles, rows) {
  const covered = new Set(profiles.map((p) => p.departmentId).filter(Boolean))
  for (const row of rows) {
    const id = row.employee.department?.id
    if (id && row.profile) covered.add(id)
  }
  return departments.filter((d) => !covered.has(d.id)).map((d) => ({ id: d.id, name: d.name }))
}
