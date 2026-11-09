-- DropForeignKey
ALTER TABLE "AmbassadorReport" DROP CONSTRAINT "AmbassadorReport_decidedById_fkey";

-- DropForeignKey
ALTER TABLE "UserTaskStat" DROP CONSTRAINT "UserTaskStat_userId_fkey";

-- AddForeignKey
ALTER TABLE "UserTaskStat" ADD CONSTRAINT "UserTaskStat_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AmbassadorReport" ADD CONSTRAINT "AmbassadorReport_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
