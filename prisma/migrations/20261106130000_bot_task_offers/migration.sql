-- CreateTable
CREATE TABLE "BotTaskOffer" (
    "id" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "assigneeId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "deadline" TIMESTAMP(3) NOT NULL,
    "startAt" TIMESTAMP(3),
    "workId" TEXT,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "taskId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "BotTaskOffer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BotTaskOffer_requesterId_createdAt_idx" ON "BotTaskOffer"("requesterId", "createdAt");

-- AddForeignKey
ALTER TABLE "BotTaskOffer" ADD CONSTRAINT "BotTaskOffer_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotTaskOffer" ADD CONSTRAINT "BotTaskOffer_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
