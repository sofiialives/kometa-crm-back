-- Очередь «На проверке» и лимит личных задач (по звонку с Яном 13.10.2026).
-- Баллы за задачи пока начисляет владелец сам: CRM кладёт заявку с
-- подсказанными баллами, он решает. Включается той же датой autoTasksFrom,
-- что и раньше, — до неё ничего не происходит.

CREATE TYPE "MotivationTaskPointsMode" AS ENUM ('review', 'auto');
CREATE TYPE "MotivationReviewStatus" AS ENUM ('pending', 'approved', 'rejected', 'withdrawn');
CREATE TYPE "MotivationComplexity" AS ENUM ('low', 'medium', 'high');

ALTER TABLE "MotivationSettings" ADD COLUMN "personalTaskDailyLimit" INTEGER NOT NULL DEFAULT 7,
ADD COLUMN "taskPointsMode" "MotivationTaskPointsMode" NOT NULL DEFAULT 'review';

CREATE TABLE "MotivationReview" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rule" "MotivationAutoRule" NOT NULL,
    "eventTypeId" TEXT,
    "title" TEXT NOT NULL,
    "prizePoints" INTEGER NOT NULL,
    "levelPoints" INTEGER NOT NULL,
    "taskId" TEXT,
    "taskTitle" TEXT,
    "taskDescription" TEXT,
    "taskDeadline" TIMESTAMP(3),
    "complexity" "MotivationComplexity",
    "nights" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "status" "MotivationReviewStatus" NOT NULL DEFAULT 'pending',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "eventId" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MotivationReview_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MotivationReview_eventId_key" ON "MotivationReview"("eventId");
CREATE UNIQUE INDEX "MotivationReview_dedupeKey_key" ON "MotivationReview"("dedupeKey");
CREATE INDEX "MotivationReview_status_occurredAt_idx" ON "MotivationReview"("status", "occurredAt");
CREATE INDEX "MotivationReview_userId_status_idx" ON "MotivationReview"("userId", "status");
CREATE INDEX "MotivationReview_taskId_idx" ON "MotivationReview"("taskId");

ALTER TABLE "MotivationReview" ADD CONSTRAINT "MotivationReview_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MotivationReview" ADD CONSTRAINT "MotivationReview_eventTypeId_fkey" FOREIGN KEY ("eventTypeId") REFERENCES "MotivationEventType"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MotivationReview" ADD CONSTRAINT "MotivationReview_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MotivationReview" ADD CONSTRAINT "MotivationReview_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "MotivationEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
