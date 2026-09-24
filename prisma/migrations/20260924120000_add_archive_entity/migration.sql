-- Архив отчётов по клиентам: три новые таблицы.
--
-- Миграция написана руками, как и все предыдущие. Сгенерированный файл
-- потащил бы за собой CREATE TYPE "TaskPriority", ALTER TABLE "Task"
-- ADD COLUMN "priority" и пересоздание внешнего ключа "UserTaskStat" —
-- всё это на проде давно есть, а в истории миграций отсутствует. На бою
-- такая миграция упала бы на "already exists", пометилась сбойной и
-- уронила бы деплой всего бэкенда: migrate deploy стоит в buildCommand
-- в render.yaml.
--
-- Здесь только новое. Ни Task, ни User, ни Department, ни Client,
-- ни Work, ни Call не меняются.

CREATE TABLE "ArchiveClient" (
    "id"        TEXT NOT NULL,
    "clientId"  TEXT NOT NULL,
    "addedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ArchiveClient_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ArchiveService" (
    "id"              TEXT NOT NULL,
    "archiveClientId" TEXT NOT NULL,
    "departmentId"    TEXT NOT NULL,
    "title"           TEXT NOT NULL,
    "createdById"     TEXT NOT NULL,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ArchiveService_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ArchiveReport" (
    "id"          TEXT NOT NULL,
    "serviceId"   TEXT NOT NULL,
    "authorId"    TEXT NOT NULL,
    "fileKey"     TEXT NOT NULL,
    "fileName"    TEXT NOT NULL,
    "fileSize"    INTEGER NOT NULL,
    "workedAt"    TIMESTAMP(3) NOT NULL,
    "textContent" TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ArchiveReport_pkey" PRIMARY KEY ("id")
);

-- Один клиент — одна карточка в архиве.
CREATE UNIQUE INDEX "ArchiveClient_clientId_key" ON "ArchiveClient"("clientId");

-- Вкладка отдела и раскрытая карточка клиента — два основных запроса.
CREATE INDEX "ArchiveService_departmentId_idx" ON "ArchiveService"("departmentId");
CREATE INDEX "ArchiveService_archiveClientId_idx" ON "ArchiveService"("archiveClientId");

-- Две записи не должны указывать на один файл в хранилище: удаление одной
-- унесло бы файл у второй.
CREATE UNIQUE INDEX "ArchiveReport_fileKey_key" ON "ArchiveReport"("fileKey");

CREATE INDEX "ArchiveReport_serviceId_workedAt_idx" ON "ArchiveReport"("serviceId", "workedAt");
CREATE INDEX "ArchiveReport_authorId_idx" ON "ArchiveReport"("authorId");

-- RESTRICT на клиента — то самое поведение, которое подтвердил заказчик:
-- клиента, по которому есть архив, удалить нельзя. Понятное сообщение
-- вместо ошибки базы выдаёт client.service.js.
ALTER TABLE "ArchiveClient" ADD CONSTRAINT "ArchiveClient_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RESTRICT на авторов: сотрудников в CRM не удаляют, а деактивируют, но
-- архив обязан помнить, кто что занёс, даже если человек ушёл.
ALTER TABLE "ArchiveClient" ADD CONSTRAINT "ArchiveClient_addedById_fkey"
    FOREIGN KEY ("addedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CASCADE вниз по архиву: убрали клиента из архива — ушли его услуги,
-- убрали услугу — ушли её отчёты. Файлы из хранилища при этом удаляет
-- сервис отдельно, база о хранилище ничего не знает.
ALTER TABLE "ArchiveService" ADD CONSTRAINT "ArchiveService_archiveClientId_fkey"
    FOREIGN KEY ("archiveClientId") REFERENCES "ArchiveClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ArchiveService" ADD CONSTRAINT "ArchiveService_departmentId_fkey"
    FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ArchiveService" ADD CONSTRAINT "ArchiveService_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ArchiveReport" ADD CONSTRAINT "ArchiveReport_serviceId_fkey"
    FOREIGN KEY ("serviceId") REFERENCES "ArchiveService"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ArchiveReport" ADD CONSTRAINT "ArchiveReport_authorId_fkey"
    FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
