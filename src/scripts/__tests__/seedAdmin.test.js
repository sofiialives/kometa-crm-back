import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

// Скрипт запускаем как есть, отдельным процессом. Адрес базы — заведомо
// недоступный: если проверка пароля не сработает, скрипт упадёт на
// подключении, а не создаст админа в настоящей базе.

const seedScript = fileURLToPath(new URL('../seedAdmin.js', import.meta.url))

test('без SEED_ADMIN_PASSWORD сид не создаёт админа и объясняет, что задать', () => {
  const result = spawnSync(process.execPath, [seedScript], {
    cwd: tmpdir(),
    env: {
      PATH: process.env.PATH,
      SEED_ADMIN_PASSWORD: '',
      DATABASE_URL: 'postgresql://nobody@127.0.0.1:1/none',
    },
    encoding: 'utf8',
    timeout: 10_000,
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /не задан SEED_ADMIN_PASSWORD/)
  assert.doesNotMatch(result.stdout, /создан первый админ/)
})
