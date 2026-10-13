-- Этап 3 мотивации: закрытие месяца со снимком итогов и подсказка
-- «Пополнить банк?» о новой работе в Иерархии. Только добавляет таблицы:
-- существующие данные не меняются.

CREATE TYPE "MotivationHintStatus" AS ENUM ('pending', 'done', 'dismissed');

CREATE TABLE "MotivationMonthClose" (
    "monthKey" TEXT NOT NULL,
    "closedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MotivationMonthClose_pkey" PRIMARY KEY ("monthKey")
);

CREATE TABLE "MotivationMonthResult" (
    "id" TEXT NOT NULL,
    "monthKey" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "employee" JSONB NOT NULL,
    "profile" JSONB,
    "bankCents" INTEGER NOT NULL,
    "earnedCents" INTEGER NOT NULL,
    "prizePoints" INTEGER NOT NULL,
    "levelPoints" INTEGER NOT NULL,
    "currentLevel" INTEGER NOT NULL,
    "levelsCount" INTEGER NOT NULL,
    "eventsCount" INTEGER NOT NULL,
    "levels" JSONB NOT NULL,
    "work" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MotivationMonthResult_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MotivationWorkHint" (
    "id" TEXT NOT NULL,
    "workId" TEXT NOT NULL,
    "workTitle" TEXT NOT NULL,
    "clientId" TEXT,
    "clientName" TEXT,
    "departmentId" TEXT,
    "departmentName" TEXT,
    "assigneeIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdByName" TEXT,
    "status" "MotivationHintStatus" NOT NULL DEFAULT 'pending',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MotivationWorkHint_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MotivationMonthResult_userId_idx" ON "MotivationMonthResult"("userId");

CREATE UNIQUE INDEX "MotivationMonthResult_monthKey_userId_key" ON "MotivationMonthResult"("monthKey", "userId");

CREATE UNIQUE INDEX "MotivationWorkHint_workId_key" ON "MotivationWorkHint"("workId");

CREATE INDEX "MotivationWorkHint_status_createdAt_idx" ON "MotivationWorkHint"("status", "createdAt");

ALTER TABLE "MotivationMonthResult" ADD CONSTRAINT "MotivationMonthResult_monthKey_fkey" FOREIGN KEY ("monthKey") REFERENCES "MotivationMonthClose"("monthKey") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MotivationMonthResult" ADD CONSTRAINT "MotivationMonthResult_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MotivationWorkHint" ADD CONSTRAINT "MotivationWorkHint_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

