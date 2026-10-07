-- Архив становится раздельным по отделам.
--
-- Было: одна запись клиента на весь архив, отдел только у услуги. Из-за
-- этого вкладка отдела показывала чужих клиентов пустыми карточками, а
-- занести клиента, которого уже завёл другой отдел, было нельзя вовсе.
--
-- Стало: у записи свой отдел, уникальность — пара (клиент, отдел).
--
-- Миграция написана РУКАМИ, как и все здесь: в истории нет Task.priority,
-- хотя на проде колонка есть, и сгенерированный файл потащил бы её за собой.
-- Task тут не трогается.
--
-- Данные переносятся, ничего не удаляется: клиент, которым занимались два
-- отдела, разворачивается в две записи, и услуги переезжают к записи своего
-- отдела вместе с отчётами.

-- 1. Колонка и связь.
ALTER TABLE "ArchiveClient" ADD COLUMN "departmentId" TEXT;

ALTER TABLE "ArchiveClient" ADD CONSTRAINT "ArchiveClient_departmentId_fkey"
    FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 2. Старое ограничение «один клиент — одна запись на весь архив» снимаем
--    СРАЗУ: ниже, на шаге 4, у клиента с двумя отделами появится вторая
--    запись, и при живом ограничении вставка упала бы, а с ней и деплой.
DROP INDEX IF EXISTS "ArchiveClient_clientId_key";

-- 3. Запись забирает отдел своей самой ранней услуги. Для записей с услугами
--    одного отдела этого достаточно, остальные доберём шагом 3.
UPDATE "ArchiveClient" ac
SET "departmentId" = (
    SELECT s."departmentId" FROM "ArchiveService" s
    WHERE s."archiveClientId" = ac.id
    ORDER BY s."createdAt" ASC, s.id ASC
    LIMIT 1
);

-- 4. Клиент с услугами в нескольких отделах: на каждый недостающий отдел
--    заводим отдельную запись. Кто занёс и когда — сохраняем от исходной,
--    чтобы в карточке осталась правдивая история.
INSERT INTO "ArchiveClient" ("id", "clientId", "departmentId", "addedById", "createdAt", "updatedAt")
SELECT
    substr(md5(random()::text || clock_timestamp()::text || ac.id || d."departmentId"), 1, 25),
    ac."clientId",
    d."departmentId",
    ac."addedById",
    ac."createdAt",
    NOW()
FROM "ArchiveClient" ac
JOIN (SELECT DISTINCT "archiveClientId", "departmentId" FROM "ArchiveService") d
  ON d."archiveClientId" = ac.id
WHERE ac."departmentId" IS NOT NULL
  AND d."departmentId" <> ac."departmentId";

-- 5. Услуги переезжают к записи своего отдела. Отчёты висят на услугах и
--    едут вместе с ними — отдельного шага для них не нужно.
UPDATE "ArchiveService" s
SET "archiveClientId" = target."id"
FROM "ArchiveClient" src, "ArchiveClient" target
WHERE s."archiveClientId" = src."id"
  AND target."clientId" = src."clientId"
  AND target."departmentId" = s."departmentId"
  AND target."id" <> src."id";

-- 6. Записи без единой услуги забирают отдел того, кто их заводил. У админа
--    своего отдела нет — такие остаются без отдела и работают как заготовка:
--    видны всем, достаются первому, кто заведёт в них услугу.
UPDATE "ArchiveClient" ac
SET "departmentId" = u."departmentId"
FROM "User" u
WHERE ac."addedById" = u."id"
  AND ac."departmentId" IS NULL
  AND u."departmentId" IS NOT NULL;

-- 7. Новое ограничение: один клиент — одна запись В СВОЁМ отделе.
CREATE UNIQUE INDEX "ArchiveClient_clientId_departmentId_key" ON "ArchiveClient"("clientId", "departmentId");
CREATE INDEX "ArchiveClient_departmentId_idx" ON "ArchiveClient"("departmentId");
