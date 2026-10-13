-- Агент в боте, часть без ИИ (решения от 14.10.2026): журнал переписки,
-- отметки «уже отправлено», внезапные чек-ины, вид отлучки (перерыв или
-- форс-мажор) и событие «Не ответил на внезапный чек-ин» (−3) в каждом
-- профиле. Существующие данные не меняются: прежние метки — форс-мажоры,
-- поставленные владельцем.

CREATE TYPE "MotivationAwayKind" AS ENUM ('break', 'force_majeure');

CREATE TYPE "MotivationAwaySource" AS ENUM ('owner', 'bot');

CREATE TYPE "BotCheckinStatus" AS ENUM ('asked', 'answered', 'skipped', 'penalized');

ALTER TABLE "MotivationAway" ADD COLUMN     "extensions" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "kind" "MotivationAwayKind" NOT NULL DEFAULT 'force_majeure',
ADD COLUMN     "returnAskedAt" TIMESTAMP(3),
ADD COLUMN     "returnedAt" TIMESTAMP(3),
ADD COLUMN     "source" "MotivationAwaySource" NOT NULL DEFAULT 'owner';

ALTER TABLE "MotivationSettings" ADD COLUMN     "checkinFrom" TIMESTAMP(3);

CREATE TABLE "BotMessage" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "chatId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BotMessage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BotNotice" (
    "key" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BotNotice_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "BotCheckin" (
    "id" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "plannedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "deadlineAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BotCheckin_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BotCheckinAnswer" (
    "id" TEXT NOT NULL,
    "checkinId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "BotCheckinStatus" NOT NULL DEFAULT 'asked',
    "answer" TEXT,
    "answeredAt" TIMESTAMP(3),
    "eventId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BotCheckinAnswer_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BotMessage_userId_createdAt_idx" ON "BotMessage"("userId", "createdAt");

CREATE UNIQUE INDEX "BotCheckin_day_key" ON "BotCheckin"("day");

CREATE UNIQUE INDEX "BotCheckinAnswer_checkinId_userId_key" ON "BotCheckinAnswer"("checkinId", "userId");

ALTER TABLE "BotMessage" ADD CONSTRAINT "BotMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "BotCheckinAnswer" ADD CONSTRAINT "BotCheckinAnswer_checkinId_fkey" FOREIGN KEY ("checkinId") REFERENCES "BotCheckin"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BotCheckinAnswer" ADD CONSTRAINT "BotCheckinAnswer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Событие чек-ина в каждом профиле, включая созданные владельцем.
SET TIME ZONE 'UTC';
INSERT INTO "MotivationEventType"
    ("id", "profileId", "title", "example", "prizePoints", "levelPoints", "mode", "autoRule", "systemKey", "position", "updatedAt")
SELECT 'mevt_' || p."id" || '_checkin_missed', p."id", 'Не ответил на внезапный чек-ин',
       'Бот спросил, чем вы заняты, а ответа не было 45 минут и вы не предупреждали, что отойдёте',
       -3, -3, 'manual', NULL, 'checkin_missed', 92, (now() AT TIME ZONE 'UTC')
FROM "MotivationProfile" p
WHERE NOT EXISTS (SELECT 1 FROM "MotivationEventType" t WHERE t."profileId" = p."id" AND t."systemKey" = 'checkin_missed');
