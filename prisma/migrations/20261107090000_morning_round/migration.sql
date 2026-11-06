-- Утренний обход: вид поручения и предложенная задача.
ALTER TABLE "BotRound" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'ask';
ALTER TABLE "BotRoundTarget" ADD COLUMN "offeredTaskId" TEXT;
