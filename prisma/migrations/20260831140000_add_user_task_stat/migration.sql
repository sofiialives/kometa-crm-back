CREATE TABLE "UserTaskStat" (
    "userId" TEXT NOT NULL,
    "doneCount" INTEGER NOT NULL DEFAULT 0,
    "overdueCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "UserTaskStat_pkey" PRIMARY KEY ("userId")
);

ALTER TABLE "UserTaskStat" ADD CONSTRAINT "UserTaskStat_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;