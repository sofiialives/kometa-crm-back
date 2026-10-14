-- CreateTable
CREATE TABLE "BotReminder" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "text" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BotReminder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BotReminder_at_idx" ON "BotReminder"("at");

-- CreateIndex
CREATE INDEX "BotReminder_userId_at_idx" ON "BotReminder"("userId", "at");

-- AddForeignKey
ALTER TABLE "BotReminder" ADD CONSTRAINT "BotReminder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

