-- AlterTable
ALTER TABLE "BotStyleNote" ADD COLUMN "approvedAt" TIMESTAMP(3);

-- Заметки, записанные до этой миграции, уже действуют.
UPDATE "BotStyleNote" SET "approvedAt" = "createdAt";
