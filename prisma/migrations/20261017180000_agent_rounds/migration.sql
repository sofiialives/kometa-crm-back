-- AlterTable
ALTER TABLE "BotMessage" ADD COLUMN "fileId" TEXT,
ADD COLUMN "fileKind" TEXT,
ADD COLUMN "fileMime" TEXT,
ADD COLUMN "source" TEXT,
ADD COLUMN "roundTargetId" TEXT;

-- AlterTable
ALTER TABLE "AiUsage" ADD COLUMN "costMicros" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "BotRound" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "collect" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "deadlineAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "nudgedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "reportText" TEXT,
    "reportTries" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BotRound_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BotRoundTarget" (
    "id" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "summary" TEXT,
    "replies" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMP(3),
    "answeredAt" TIMESTAMP(3),

    CONSTRAINT "BotRoundTarget_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BotMessage_roundTargetId_idx" ON "BotMessage"("roundTargetId");

-- CreateIndex
CREATE INDEX "BotRound_status_deadlineAt_idx" ON "BotRound"("status", "deadlineAt");

-- CreateIndex
CREATE INDEX "BotRoundTarget_userId_status_idx" ON "BotRoundTarget"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "BotRoundTarget_roundId_userId_key" ON "BotRoundTarget"("roundId", "userId");

-- AddForeignKey
ALTER TABLE "BotMessage" ADD CONSTRAINT "BotMessage_roundTargetId_fkey" FOREIGN KEY ("roundTargetId") REFERENCES "BotRoundTarget"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotRound" ADD CONSTRAINT "BotRound_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotRoundTarget" ADD CONSTRAINT "BotRoundTarget_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "BotRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotRoundTarget" ADD CONSTRAINT "BotRoundTarget_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
