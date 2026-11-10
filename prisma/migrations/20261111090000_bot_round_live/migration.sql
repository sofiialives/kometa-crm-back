-- Опрос без названного срока: каждый ответ уходит тому, кто поручил, сразу.
-- Откат: ALTER TABLE "BotRound" DROP COLUMN "live";
ALTER TABLE "BotRound" ADD COLUMN "live" BOOLEAN NOT NULL DEFAULT false;
