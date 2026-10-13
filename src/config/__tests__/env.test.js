import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

// Настройки читаются один раз при загрузке модуля, поэтому каждый случай
// запускаем в отдельном процессе. Рабочая папка — временная, чтобы
// подхватить чужой .env было неоткуда, а пустая строка считается «не
// задано» и dotenv её не перезаписывает.

const envModule = fileURLToPath(new URL('../env.js', import.meta.url))

function loadEnv(vars) {
  const script = `const { env } = await import(${JSON.stringify(envModule)});
    console.log(JSON.stringify({ access: env.jwtAccessSecret, refresh: env.jwtRefreshSecret }))`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: tmpdir(),
    env: { PATH: process.env.PATH, JWT_ACCESS_SECRET: '', JWT_REFRESH_SECRET: '', ...vars },
    encoding: 'utf8',
  })
  return {
    code: result.status,
    stderr: result.stderr,
    secrets: result.status === 0 ? JSON.parse(result.stdout) : null,
  }
}

describe('секреты токенов входа', () => {
  test('в разработке без секретов подставляются временные', () => {
    const { code, secrets } = loadEnv({ NODE_ENV: 'development' })
    assert.equal(code, 0)
    assert.deepEqual(secrets, { access: 'dev-access-secret', refresh: 'dev-refresh-secret' })
  })

  test('без NODE_ENV считается разработкой', () => {
    const { code, secrets } = loadEnv({})
    assert.equal(code, 0)
    assert.equal(secrets.access, 'dev-access-secret')
  })

  test('на проде без секретов сервер не стартует', () => {
    const { code, stderr } = loadEnv({ NODE_ENV: 'production' })
    assert.notEqual(code, 0)
    assert.match(stderr, /Не задана переменная окружения JWT_ACCESS_SECRET/)
  })

  test('на проде не хватает только одного секрета — тоже не стартует', () => {
    const { code, stderr } = loadEnv({ NODE_ENV: 'production', JWT_ACCESS_SECRET: 'access-from-render' })
    assert.notEqual(code, 0)
    assert.match(stderr, /Не задана переменная окружения JWT_REFRESH_SECRET/)
  })

  test('NODE_ENV с другим регистром и пробелами — тоже прод', () => {
    const { code, stderr } = loadEnv({ NODE_ENV: ' Production ' })
    assert.notEqual(code, 0)
    assert.match(stderr, /Не задана переменная окружения JWT_ACCESS_SECRET/)
  })

  test('секрет из одних пробелов на проде считается незаданным', () => {
    const { code, stderr } = loadEnv({
      NODE_ENV: 'production',
      JWT_ACCESS_SECRET: '   ',
      JWT_REFRESH_SECRET: 'refresh-from-render',
    })
    assert.notEqual(code, 0)
    assert.match(stderr, /Не задана переменная окружения JWT_ACCESS_SECRET/)
  })

  test('на проде с заданными секретами берутся они', () => {
    const { code, secrets } = loadEnv({
      NODE_ENV: 'production',
      JWT_ACCESS_SECRET: 'access-from-render',
      JWT_REFRESH_SECRET: 'refresh-from-render',
    })
    assert.equal(code, 0)
    assert.deepEqual(secrets, { access: 'access-from-render', refresh: 'refresh-from-render' })
  })
})
