-- Связка сотрудника с телеграмом для бота напоминаний.
--
-- Миграция написана руками, как и предыдущие: в истории миграций нет
-- Task.priority, и сгенерированный файл потащил бы её за собой, уронив
-- деплой бэкенда на проде (render.yaml запускает migrate deploy в сборке).
--
-- Здесь только новая таблица. Ни Task, ни User, ни Call не меняются.

CREATE TABLE "TelegramLink" (
    "userId"        TEXT NOT NULL,
    "code"          TEXT,
    "codeExpiresAt" TIMESTAMP(3),
    "chatId"        TEXT,
    "username"      TEXT,
    "linkedAt"      TIMESTAMP(3),
    "updatedAt"     TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TelegramLink_pkey" PRIMARY KEY ("userId")
);

-- Код одноразовый и ищется ботом напрямую, поэтому уникальный индекс.
CREATE UNIQUE INDEX "TelegramLink_code_key" ON "TelegramLink"("code");

-- CASCADE: уволили сотрудника — связка уходит вместе с ним, чтобы бот
-- не писал в чат человека, которого в CRM больше нет.
ALTER TABLE "TelegramLink" ADD CONSTRAINT "TelegramLink_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
