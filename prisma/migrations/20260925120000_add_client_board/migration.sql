-- Доска клиентов: финансовый учёт агентства.
--
-- Миграция написана руками, как и все предыдущие. Сгенерированная потащила
-- бы CREATE TYPE "TaskPriority", ALTER TABLE "Task" ADD COLUMN "priority" и
-- пересоздание внешнего ключа "UserTaskStat" — на проде это давно есть, а в
-- истории миграций отсутствует. На бою такая миграция упала бы на
-- "already exists", пометилась сбойной и уронила деплой всего бэкенда:
-- migrate deploy стоит в buildCommand в render.yaml.
--
-- Здесь только новое. Ни Task, ни User, ни Client, ни Archive не меняются.

CREATE TYPE "BoardClientStatus" AS ENUM ('active', 'left');

CREATE TABLE "BoardClient" (
    "id"         TEXT NOT NULL,
    "clientId"   TEXT NOT NULL,
    "contact"    TEXT,
    "status"     "BoardClientStatus" NOT NULL DEFAULT 'active',
    "startedAt"  TIMESTAMP(3) NOT NULL,
    "leftAt"     TIMESTAMP(3),
    "leftReason" TEXT,
    "addedById"  TEXT NOT NULL,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BoardClient_pkey" PRIMARY KEY ("id")
);

-- Выручка в центах целым числом: доллары с копейками в JavaScript
-- складываются с ошибкой, и на суммах агентства это вылезло бы в отчётах.
CREATE TABLE "BoardService" (
    "id"            TEXT NOT NULL,
    "boardClientId" TEXT NOT NULL,
    "title"         TEXT NOT NULL,
    "month"         TIMESTAMP(3) NOT NULL,
    "revenueCents"  INTEGER NOT NULL,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BoardService_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BoardExpense" (
    "id"          TEXT NOT NULL,
    "serviceId"   TEXT NOT NULL,
    "title"       TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BoardExpense_pkey" PRIMARY KEY ("id")
);

-- Один клиент — одна карточка на доске.
CREATE UNIQUE INDEX "BoardClient_clientId_key" ON "BoardClient"("clientId");

-- Доска всегда разложена на две колонки по статусу.
CREATE INDEX "BoardClient_status_idx" ON "BoardClient"("status");

-- Два основных запроса: услуги клиента за период и сводка по всем услугам
-- за период.
CREATE INDEX "BoardService_boardClientId_month_idx" ON "BoardService"("boardClientId", "month");
CREATE INDEX "BoardService_month_idx" ON "BoardService"("month");

CREATE INDEX "BoardExpense_serviceId_idx" ON "BoardExpense"("serviceId");

-- RESTRICT на клиента: удалить того, по кому ведётся финансовый учёт, база
-- не даст. Понятное сообщение вместо ошибки Postgres выдаёт client.service.js.
ALTER TABLE "BoardClient" ADD CONSTRAINT "BoardClient_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RESTRICT на того, кто занёс: сотрудников не удаляют, а деактивируют, но
-- история должна помнить автора.
ALTER TABLE "BoardClient" ADD CONSTRAINT "BoardClient_addedById_fkey"
    FOREIGN KEY ("addedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CASCADE вниз: убрали клиента с доски — ушли его услуги, убрали услугу —
-- ушли её расходы.
ALTER TABLE "BoardService" ADD CONSTRAINT "BoardService_boardClientId_fkey"
    FOREIGN KEY ("boardClientId") REFERENCES "BoardClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BoardExpense" ADD CONSTRAINT "BoardExpense_serviceId_fkey"
    FOREIGN KEY ("serviceId") REFERENCES "BoardService"("id") ON DELETE CASCADE ON UPDATE CASCADE;
