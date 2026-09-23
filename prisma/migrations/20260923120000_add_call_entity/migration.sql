-- Календарь звонков. Миграция написана РУКАМИ, а не сгенерирована
-- `prisma migrate dev`, и это осознанно.
--
-- Генератор сравнивает schema.prisma с историей миграций, а в этой истории
-- отсутствует колонка Task.priority: она есть в схеме и на проде, но ни
-- одна миграция её не создаёт. Сгенерированная миграция потащила бы за
-- собой `ALTER TABLE "Task" ADD COLUMN "priority"`, на проде это упало бы
-- с "column already exists", миграция пометилась бы сбойной, а вместе с
-- ней лёг бы и весь деплой бэкенда (см. render.yaml: migrate deploy стоит
-- в buildCommand).
--
-- Поэтому здесь только создание новой таблицы. Ни одной строки, меняющей
-- Task, User или Department — их структура остаётся ровно такой, какая
-- сейчас на бою, и задачи сотрудников эта миграция не касается вообще.

CREATE TABLE "Call" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "note" TEXT,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "ownerId" TEXT NOT NULL,
    "departmentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Call_pkey" PRIMARY KEY ("id")
);

-- Выборки всегда идут по владельцу или отделу и сортируются по времени —
-- составные индексы под оба сценария видимости (свои / отдел).
CREATE INDEX "Call_ownerId_scheduledAt_idx" ON "Call"("ownerId", "scheduledAt");
CREATE INDEX "Call_departmentId_scheduledAt_idx" ON "Call"("departmentId", "scheduledAt");

-- RESTRICT на владельце: звонки не должны молча исчезать вместе с
-- пользователем. SET NULL на отделе: отдел могут расформировать, звонок
-- при этом остаётся у своего автора.
ALTER TABLE "Call" ADD CONSTRAINT "Call_ownerId_fkey"
    FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Call" ADD CONSTRAINT "Call_departmentId_fkey"
    FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;
