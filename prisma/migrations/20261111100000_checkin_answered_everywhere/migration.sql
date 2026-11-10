-- «Ответил на внезапный чек-ин» (+2) появлялся только в новых профилях, а
-- добавить системное событие из CRM нельзя: у действующих отделов плюс за
-- ответ не начислялся бы никогда. Добавляем туда, где его нет, в конец списка.
-- Откат: DELETE FROM "MotivationEventType" WHERE "id" LIKE 'ckans_%';
INSERT INTO "MotivationEventType" ("id", "profileId", "title", "example", "prizePoints", "levelPoints", "mode", "systemKey", "enabled", "position", "review", "createdAt", "updatedAt")
SELECT 'ckans_' || md5(p."id"), p."id", 'Ответил на внезапный чек-ин', 'Бот спросил, чем вы заняты, и вы ответили в течение 45 минут', 2, 2, 'manual', 'checkin_answered', true,
  COALESCE((SELECT MAX(t."position") FROM "MotivationEventType" t WHERE t."profileId" = p."id"), 0) + 1, false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "MotivationProfile" p
WHERE NOT EXISTS (SELECT 1 FROM "MotivationEventType" t WHERE t."profileId" = p."id" AND t."systemKey" = 'checkin_answered');
