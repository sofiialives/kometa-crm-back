-- CreateTable
CREATE TABLE "BotStyleNote" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "text" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),

    CONSTRAINT "BotStyleNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BotStyleNote_userId_removedAt_idx" ON "BotStyleNote"("userId", "removedAt");

-- AddForeignKey
ALTER TABLE "BotStyleNote" ADD CONSTRAINT "BotStyleNote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotStyleNote" ADD CONSTRAINT "BotStyleNote_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
