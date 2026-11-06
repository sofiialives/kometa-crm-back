/**
 * Подмена метода на время одного теста. У Prisma методы моделей — свойства
 * с геттером, node:test mock.method с ними не работает, поэтому подменяем
 * присваиванием и возвращаем на место в конце теста. Возвращает список
 * вызовов (аргументы каждого).
 */
export function patch(t, object, name, fn) {
  const original = object[name]
  const calls = []
  object[name] = (...args) => {
    calls.push(args)
    return fn(...args)
  }
  t.after(() => { object[name] = original })
  return calls
}
