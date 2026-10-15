-- AlterEnum
ALTER TYPE "MotivationAutoRule" ADD VALUE 'task_not_started';

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

-- AlterTable
ALTER TABLE "MotivationAssignment" ALTER COLUMN "profileId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "MotivationProfile_departmentId_audience_idx" ON "MotivationProfile"("departmentId", "audience");

-- AddForeignKey
ALTER TABLE "MotivationProfile" ADD CONSTRAINT "MotivationProfile_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;
