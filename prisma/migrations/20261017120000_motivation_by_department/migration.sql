-- AlterEnum
ALTER TYPE "MotivationAutoRule" ADD VALUE IF NOT EXISTS 'task_not_started';

-- CreateEnum
CREATE TYPE "MotivationAudience" AS ENUM ('staff', 'lead');

-- AlterTable
ALTER TABLE "Department" ADD COLUMN "archivedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "MotivationProfile" ADD COLUMN "departmentId" TEXT,
ADD COLUMN "audience" "MotivationAudience" NOT NULL DEFAULT 'staff',
ADD COLUMN "archivedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "MotivationEventType" ADD COLUMN "review" BOOLEAN NOT NULL DEFAULT false;

-- Режим «на проверку» был общим (MotivationSettings.taskPointsMode, по
-- умолчанию review). Теперь он у каждого автоматического события: переносим,
-- чтобы после выкладки ничего не начало начисляться само без ведома владельца.
UPDATE "MotivationEventType" SET "review" = true
WHERE "mode" = 'auto'
  AND COALESCE((SELECT "taskPointsMode"::text FROM "MotivationSettings" WHERE "id" = 'global'), 'review') <> 'auto';

-- AlterTable
ALTER TABLE "MotivationAssignment" ALTER COLUMN "profileId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "MotivationProfile_departmentId_audience_idx" ON "MotivationProfile"("departmentId", "audience");

-- CreateIndex
CREATE INDEX "MotivationEvent_occurredAt_idx" ON "MotivationEvent"("occurredAt");

-- AddForeignKey
ALTER TABLE "MotivationProfile" ADD CONSTRAINT "MotivationProfile_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;
