CREATE TYPE "AmbassadorStatus" AS ENUM ('pending', 'approved', 'rejected', 'removed');

CREATE TABLE "AmbassadorReport" (
    "id" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "managerId" TEXT NOT NULL,
    "theme" TEXT NOT NULL,
    "conditions" TEXT NOT NULL,
    "managerComment" TEXT,
    "callAt" TIMESTAMP(3),
    "telegramGroupLink" TEXT NOT NULL,
    "contactUsername" TEXT NOT NULL,
    "status" "AmbassadorStatus" NOT NULL DEFAULT 'pending',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AmbassadorReport_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AmbassadorLink" (
    "id" TEXT NOT NULL,
    "ambassadorReportId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AmbassadorLink_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AmbassadorScreenshot" (
    "id" TEXT NOT NULL,
    "ambassadorReportId" TEXT NOT NULL,
    "fileKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AmbassadorScreenshot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AmbassadorStatusLog" (
    "id" TEXT NOT NULL,
    "ambassadorReportId" TEXT NOT NULL,
    "fromStatus" "AmbassadorStatus",
    "toStatus" "AmbassadorStatus" NOT NULL,
    "actorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AmbassadorStatusLog_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AmbassadorNotification" (
    "id" TEXT NOT NULL,
    "ambassadorReportId" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AmbassadorNotification_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AmbassadorScreenshot_fileKey_key" ON "AmbassadorScreenshot"("fileKey");

CREATE INDEX "AmbassadorReport_departmentId_status_idx" ON "AmbassadorReport"("departmentId", "status");
CREATE INDEX "AmbassadorReport_managerId_idx" ON "AmbassadorReport"("managerId");
CREATE INDEX "AmbassadorLink_ambassadorReportId_idx" ON "AmbassadorLink"("ambassadorReportId");
CREATE INDEX "AmbassadorScreenshot_ambassadorReportId_idx" ON "AmbassadorScreenshot"("ambassadorReportId");
CREATE INDEX "AmbassadorStatusLog_ambassadorReportId_createdAt_idx" ON "AmbassadorStatusLog"("ambassadorReportId", "createdAt");
CREATE INDEX "AmbassadorStatusLog_toStatus_createdAt_idx" ON "AmbassadorStatusLog"("toStatus", "createdAt");
CREATE INDEX "AmbassadorNotification_recipientId_read_idx" ON "AmbassadorNotification"("recipientId", "read");
CREATE INDEX "AmbassadorNotification_ambassadorReportId_idx" ON "AmbassadorNotification"("ambassadorReportId");

ALTER TABLE "AmbassadorReport" ADD CONSTRAINT "AmbassadorReport_departmentId_fkey"
    FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AmbassadorReport" ADD CONSTRAINT "AmbassadorReport_managerId_fkey"
    FOREIGN KEY ("managerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AmbassadorReport" ADD CONSTRAINT "AmbassadorReport_decidedById_fkey"
    FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AmbassadorLink" ADD CONSTRAINT "AmbassadorLink_ambassadorReportId_fkey"
    FOREIGN KEY ("ambassadorReportId") REFERENCES "AmbassadorReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AmbassadorScreenshot" ADD CONSTRAINT "AmbassadorScreenshot_ambassadorReportId_fkey"
    FOREIGN KEY ("ambassadorReportId") REFERENCES "AmbassadorReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AmbassadorStatusLog" ADD CONSTRAINT "AmbassadorStatusLog_ambassadorReportId_fkey"
    FOREIGN KEY ("ambassadorReportId") REFERENCES "AmbassadorReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AmbassadorStatusLog" ADD CONSTRAINT "AmbassadorStatusLog_actorId_fkey"
    FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AmbassadorNotification" ADD CONSTRAINT "AmbassadorNotification_ambassadorReportId_fkey"
    FOREIGN KEY ("ambassadorReportId") REFERENCES "AmbassadorReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AmbassadorNotification" ADD CONSTRAINT "AmbassadorNotification_recipientId_fkey"
    FOREIGN KEY ("recipientId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
