-- Журнал вечернего звонка и метка «форс-мажор до …» (по звонку с Яном 13.10.2026).
-- Был на звонке — баллы события «Был на созвоне» (call_attended), не был —
-- штраф «Пропустил звонок» (call_missed), форс-мажор — без баллов. Оба события
-- системные: их отмечают в журнале, а не формой ручных баллов.

CREATE TYPE "MotivationCallStatus" AS ENUM ('present', 'absent', 'excused');

CREATE TABLE "MotivationCallMark" (
    "id" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "MotivationCallStatus" NOT NULL,
    "eventId" TEXT,
    "markedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MotivationCallMark_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MotivationAway" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "until" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "createdById" TEXT NOT NULL,
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MotivationAway_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MotivationCallMark_eventId_key" ON "MotivationCallMark"("eventId");

CREATE INDEX "MotivationCallMark_day_idx" ON "MotivationCallMark"("day");

CREATE UNIQUE INDEX "MotivationCallMark_day_userId_key" ON "MotivationCallMark"("day", "userId");

CREATE INDEX "MotivationAway_userId_until_idx" ON "MotivationAway"("userId", "until");

ALTER TABLE "MotivationCallMark" ADD CONSTRAINT "MotivationCallMark_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MotivationCallMark" ADD CONSTRAINT "MotivationCallMark_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "MotivationEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MotivationCallMark" ADD CONSTRAINT "MotivationCallMark_markedById_fkey" FOREIGN KEY ("markedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MotivationAway" ADD CONSTRAINT "MotivationAway_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MotivationAway" ADD CONSTRAINT "MotivationAway_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Данные: события звонка в каждом профиле, включая созданные владельцем.
SET TIME ZONE 'UTC';

-- «Был на созвоне» уже есть у разработчика, дизайнера, таргетолога и в их
-- копиях — делаем его событием журнала, по одному на профиль.
UPDATE "MotivationEventType" t
SET "systemKey" = 'call_attended', "updatedAt" = (now() AT TIME ZONE 'UTC')
WHERE t."title" = 'Был на созвоне' AND t."systemKey" IS NULL AND t."mode" = 'manual'
  AND t."id" = (
    SELECT min(y."id") FROM "MotivationEventType" y
    WHERE y."profileId" = t."profileId" AND y."title" = 'Был на созвоне' AND y."systemKey" IS NULL AND y."mode" = 'manual'
  )
  AND NOT EXISTS (
    SELECT 1 FROM "MotivationEventType" x WHERE x."profileId" = t."profileId" AND x."systemKey" = 'call_attended'
  );

-- У остальных профилей (руководитель, новые) — добавляем.
INSERT INTO "MotivationEventType"
    ("id", "profileId", "title", "example", "prizePoints", "levelPoints", "mode", "autoRule", "systemKey", "position", "updatedAt")
SELECT 'mevt_' || p."id" || '_call_attended', p."id", 'Был на вечернем звонке',
       'Владелец отметил вас в журнале звонка', 1, 1, 'manual', NULL, 'call_attended', 90, (now() AT TIME ZONE 'UTC')
FROM "MotivationProfile" p
WHERE NOT EXISTS (SELECT 1 FROM "MotivationEventType" t WHERE t."profileId" = p."id" AND t."systemKey" = 'call_attended');

INSERT INTO "MotivationEventType"
    ("id", "profileId", "title", "example", "prizePoints", "levelPoints", "mode", "autoRule", "systemKey", "position", "updatedAt")
SELECT 'mevt_' || p."id" || '_call_missed', p."id", 'Пропустил звонок',
       'Не было на вечернем звонке без предупреждения', -1, -1, 'manual', NULL, 'call_missed', 91, (now() AT TIME ZONE 'UTC')
FROM "MotivationProfile" p
WHERE NOT EXISTS (SELECT 1 FROM "MotivationEventType" t WHERE t."profileId" = p."id" AND t."systemKey" = 'call_missed');
