-- Клиент становится настоящей сущностью вместо текстового поля в Work.
-- Ничего из уже созданных в Иерархии клиентов не теряется: сначала
-- заводим таблицу Client и заполняем её из уже существующих различных
-- Work.clientName, потом связываем каждую Work с нужным Client по имени,
-- и только после этого удаляем старую текстовую колонку.

-- 1. Новая таблица Client
CREATE TABLE "Client" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Client_name_key" ON "Client"("name");

-- 2. Переносим уже существующих клиентов из Work.clientName —
-- id генерируем через md5 от случайного значения, не требует
-- дополнительных расширений Postgres (в отличие от gen_random_uuid()).
INSERT INTO "Client" ("id", "name", "createdAt")
SELECT md5(random()::text || clock_timestamp()::text || t."clientName"), t."clientName", now()
FROM (SELECT DISTINCT "clientName" FROM "Work") t;

-- 3. Добавляем новую колонку связи (пока необязательную)
ALTER TABLE "Work" ADD COLUMN "clientId" TEXT;

-- 4. Проставляем связь у каждой существующей работы по совпадению имени
UPDATE "Work" w
SET "clientId" = c."id"
FROM "Client" c
WHERE w."clientName" = c."name";

-- 5. Теперь, когда у всех строк есть clientId, делаем колонку обязательной
ALTER TABLE "Work" ALTER COLUMN "clientId" SET NOT NULL;

-- 6. Старая текстовая колонка больше не нужна
ALTER TABLE "Work" DROP COLUMN "clientName";

-- 7. Внешний ключ и индекс
ALTER TABLE "Work" ADD CONSTRAINT "Work_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "Work_clientId_idx" ON "Work"("clientId");
