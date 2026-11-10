-- События по умолчанию из списка Яна (9.11) во все уже созданные профили:
-- то, чего в профиле нет, дописывается в конец в порядке списка. Есть по
-- systemKey, autoRule или названию — не трогаем, кроме одного: задачи «в срок»
-- и просрочки Ян решает сам, у них включается «на решение» (review), прежнее
-- значение сохраняется в "_DefaultEventsReviewBackup".
-- Откат: checks/default-events-down.sql (удаляет добавленные по id 'dflt_%',
-- возвращает review из копии, удаляет копию).
CREATE TABLE "_DefaultEventsReviewBackup" ("id" TEXT PRIMARY KEY, "review" BOOLEAN NOT NULL);
INSERT INTO "_DefaultEventsReviewBackup" ("id", "review")
SELECT "id", "review" FROM "MotivationEventType"
WHERE "autoRule" IN ('task_on_time', 'personal_task_on_time', 'task_overdue', 'personal_task_overdue') AND "review" = false;
UPDATE "MotivationEventType" SET "review" = true, "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" IN (SELECT "id" FROM "_DefaultEventsReviewBackup");

INSERT INTO "MotivationEventType" ("id", "profileId", "title", "example", "prizePoints", "levelPoints", "mode", "autoRule", "review", "systemKey", "enabled", "position", "createdAt", "updatedAt")
SELECT 'dflt_' || md5(p."id" || '1'), p."id", 'Клиент купил дополнительный продукт', 'Клиент, с которым вы работали, заказал у агентства ещё одну услугу', 10, 10, 'manual', NULL, false, 'client_product', true,
  COALESCE((SELECT MAX(t."position") FROM "MotivationEventType" t WHERE t."profileId" = p."id"), 0) + 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "MotivationProfile" p
WHERE NOT EXISTS (SELECT 1 FROM "MotivationEventType" t WHERE t."profileId" = p."id" AND t."systemKey" = 'client_product');

INSERT INTO "MotivationEventType" ("id", "profileId", "title", "example", "prizePoints", "levelPoints", "mode", "autoRule", "review", "systemKey", "enabled", "position", "createdAt", "updatedAt")
SELECT 'dflt_' || md5(p."id" || '2'), p."id", 'Был на вечернем звонке', 'Владелец отметил вас в журнале звонка', 1, 1, 'manual', NULL, false, 'call_attended', true,
  COALESCE((SELECT MAX(t."position") FROM "MotivationEventType" t WHERE t."profileId" = p."id"), 0) + 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "MotivationProfile" p
WHERE NOT EXISTS (SELECT 1 FROM "MotivationEventType" t WHERE t."profileId" = p."id" AND t."systemKey" = 'call_attended');

INSERT INTO "MotivationEventType" ("id", "profileId", "title", "example", "prizePoints", "levelPoints", "mode", "autoRule", "review", "systemKey", "enabled", "position", "createdAt", "updatedAt")
SELECT 'dflt_' || md5(p."id" || '3'), p."id", 'Пропустил звонок', 'Не было на вечернем звонке без предупреждения', -2, -2, 'manual', NULL, false, 'call_missed', true,
  COALESCE((SELECT MAX(t."position") FROM "MotivationEventType" t WHERE t."profileId" = p."id"), 0) + 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "MotivationProfile" p
WHERE NOT EXISTS (SELECT 1 FROM "MotivationEventType" t WHERE t."profileId" = p."id" AND t."systemKey" = 'call_missed');

INSERT INTO "MotivationEventType" ("id", "profileId", "title", "example", "prizePoints", "levelPoints", "mode", "autoRule", "review", "systemKey", "enabled", "position", "createdAt", "updatedAt")
SELECT 'dflt_' || md5(p."id" || '4'), p."id", 'Ответил на внезапный чек-ин', 'Бот спросил, чем вы заняты, и вы ответили в течение 45 минут', 2, 2, 'manual', NULL, false, 'checkin_answered', true,
  COALESCE((SELECT MAX(t."position") FROM "MotivationEventType" t WHERE t."profileId" = p."id"), 0) + 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "MotivationProfile" p
WHERE NOT EXISTS (SELECT 1 FROM "MotivationEventType" t WHERE t."profileId" = p."id" AND t."systemKey" = 'checkin_answered');

INSERT INTO "MotivationEventType" ("id", "profileId", "title", "example", "prizePoints", "levelPoints", "mode", "autoRule", "review", "systemKey", "enabled", "position", "createdAt", "updatedAt")
SELECT 'dflt_' || md5(p."id" || '5'), p."id", 'Не ответил на внезапный чек-ин', 'Бот спросил, чем вы заняты, а ответа не было 45 минут и вы не предупреждали, что отойдёте', -3, -3, 'manual', NULL, false, 'checkin_missed', true,
  COALESCE((SELECT MAX(t."position") FROM "MotivationEventType" t WHERE t."profileId" = p."id"), 0) + 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "MotivationProfile" p
WHERE NOT EXISTS (SELECT 1 FROM "MotivationEventType" t WHERE t."profileId" = p."id" AND t."systemKey" = 'checkin_missed');

INSERT INTO "MotivationEventType" ("id", "profileId", "title", "example", "prizePoints", "levelPoints", "mode", "autoRule", "review", "systemKey", "enabled", "position", "createdAt", "updatedAt")
SELECT 'dflt_' || md5(p."id" || '6'), p."id", 'Задача из Иерархии закрыта в срок', NULL, 5, 5, 'auto', 'task_on_time'::"MotivationAutoRule", true, NULL, true,
  COALESCE((SELECT MAX(t."position") FROM "MotivationEventType" t WHERE t."profileId" = p."id"), 0) + 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "MotivationProfile" p
WHERE NOT EXISTS (SELECT 1 FROM "MotivationEventType" t WHERE t."profileId" = p."id" AND t."autoRule" = 'task_on_time');

INSERT INTO "MotivationEventType" ("id", "profileId", "title", "example", "prizePoints", "levelPoints", "mode", "autoRule", "review", "systemKey", "enabled", "position", "createdAt", "updatedAt")
SELECT 'dflt_' || md5(p."id" || '7'), p."id", 'Личная задача закрыта в срок', NULL, 1, 1, 'auto', 'personal_task_on_time'::"MotivationAutoRule", true, NULL, true,
  COALESCE((SELECT MAX(t."position") FROM "MotivationEventType" t WHERE t."profileId" = p."id"), 0) + 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "MotivationProfile" p
WHERE NOT EXISTS (SELECT 1 FROM "MotivationEventType" t WHERE t."profileId" = p."id" AND t."autoRule" = 'personal_task_on_time');

INSERT INTO "MotivationEventType" ("id", "profileId", "title", "example", "prizePoints", "levelPoints", "mode", "autoRule", "review", "systemKey", "enabled", "position", "createdAt", "updatedAt")
SELECT 'dflt_' || md5(p."id" || '8'), p."id", 'Просрочена личная задача', NULL, -2, -2, 'auto', 'personal_task_overdue'::"MotivationAutoRule", true, NULL, true,
  COALESCE((SELECT MAX(t."position") FROM "MotivationEventType" t WHERE t."profileId" = p."id"), 0) + 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "MotivationProfile" p
WHERE NOT EXISTS (SELECT 1 FROM "MotivationEventType" t WHERE t."profileId" = p."id" AND t."autoRule" = 'personal_task_overdue');

INSERT INTO "MotivationEventType" ("id", "profileId", "title", "example", "prizePoints", "levelPoints", "mode", "autoRule", "review", "systemKey", "enabled", "position", "createdAt", "updatedAt")
SELECT 'dflt_' || md5(p."id" || '9'), p."id", 'Просрочена задача из Иерархии', NULL, -2, -2, 'auto', 'task_overdue'::"MotivationAutoRule", true, NULL, true,
  COALESCE((SELECT MAX(t."position") FROM "MotivationEventType" t WHERE t."profileId" = p."id"), 0) + 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "MotivationProfile" p
WHERE NOT EXISTS (SELECT 1 FROM "MotivationEventType" t WHERE t."profileId" = p."id" AND t."autoRule" = 'task_overdue');

INSERT INTO "MotivationEventType" ("id", "profileId", "title", "example", "prizePoints", "levelPoints", "mode", "autoRule", "review", "systemKey", "enabled", "position", "createdAt", "updatedAt")
SELECT 'dflt_' || md5(p."id" || '10'), p."id", 'Больше 45 минут нет ответа агенту без предупреждения', 'Агент написал по делу, а ответа не было 45 минут и вы не предупреждали, что отойдёте', -3, -3, 'manual', NULL, false, NULL, true,
  COALESCE((SELECT MAX(t."position") FROM "MotivationEventType" t WHERE t."profileId" = p."id"), 0) + 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "MotivationProfile" p
WHERE NOT EXISTS (SELECT 1 FROM "MotivationEventType" t WHERE t."profileId" = p."id" AND t."title" = 'Больше 45 минут нет ответа агенту без предупреждения');

INSERT INTO "MotivationEventType" ("id", "profileId", "title", "example", "prizePoints", "levelPoints", "mode", "autoRule", "review", "systemKey", "enabled", "position", "createdAt", "updatedAt")
SELECT 'dflt_' || md5(p."id" || '11'), p."id", 'Больше 45 минут нет ответа Яну без предупреждения', 'Ян написал, а ответа не было 45 минут и вы не предупреждали, что отойдёте', -3, -3, 'manual', NULL, false, NULL, true,
  COALESCE((SELECT MAX(t."position") FROM "MotivationEventType" t WHERE t."profileId" = p."id"), 0) + 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "MotivationProfile" p
WHERE NOT EXISTS (SELECT 1 FROM "MotivationEventType" t WHERE t."profileId" = p."id" AND t."title" = 'Больше 45 минут нет ответа Яну без предупреждения');

INSERT INTO "MotivationEventType" ("id", "profileId", "title", "example", "prizePoints", "levelPoints", "mode", "autoRule", "review", "systemKey", "enabled", "position", "createdAt", "updatedAt")
SELECT 'dflt_' || md5(p."id" || '12'), p."id", 'После 10:00 не стоит ни одной задачи', NULL, -2, -2, 'auto', 'tasks_not_set'::"MotivationAutoRule", false, NULL, true,
  COALESCE((SELECT MAX(t."position") FROM "MotivationEventType" t WHERE t."profileId" = p."id"), 0) + 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "MotivationProfile" p
WHERE NOT EXISTS (SELECT 1 FROM "MotivationEventType" t WHERE t."profileId" = p."id" AND t."autoRule" = 'tasks_not_set');

INSERT INTO "MotivationEventType" ("id", "profileId", "title", "example", "prizePoints", "levelPoints", "mode", "autoRule", "review", "systemKey", "enabled", "position", "createdAt", "updatedAt")
SELECT 'dflt_' || md5(p."id" || '13'), p."id", 'Прочие плюсы', 'По договорённости с Яном в личке', 1, 1, 'manual', NULL, false, NULL, true,
  COALESCE((SELECT MAX(t."position") FROM "MotivationEventType" t WHERE t."profileId" = p."id"), 0) + 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "MotivationProfile" p
WHERE NOT EXISTS (SELECT 1 FROM "MotivationEventType" t WHERE t."profileId" = p."id" AND t."title" = 'Прочие плюсы');

INSERT INTO "MotivationEventType" ("id", "profileId", "title", "example", "prizePoints", "levelPoints", "mode", "autoRule", "review", "systemKey", "enabled", "position", "createdAt", "updatedAt")
SELECT 'dflt_' || md5(p."id" || '14'), p."id", 'Прочие минусы', 'По договорённости с Яном в личке', -1, -1, 'manual', NULL, false, NULL, true,
  COALESCE((SELECT MAX(t."position") FROM "MotivationEventType" t WHERE t."profileId" = p."id"), 0) + 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "MotivationProfile" p
WHERE NOT EXISTS (SELECT 1 FROM "MotivationEventType" t WHERE t."profileId" = p."id" AND t."title" = 'Прочие минусы');

INSERT INTO "MotivationEventType" ("id", "profileId", "title", "example", "prizePoints", "levelPoints", "mode", "autoRule", "review", "systemKey", "enabled", "position", "createdAt", "updatedAt")
SELECT 'dflt_' || md5(p."id" || '15'), p."id", 'Задача отмечена выполненной, а по факту нет', 'Неважно, из Иерархии или личная', -10, -10, 'manual', NULL, false, NULL, true,
  COALESCE((SELECT MAX(t."position") FROM "MotivationEventType" t WHERE t."profileId" = p."id"), 0) + 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "MotivationProfile" p
WHERE NOT EXISTS (SELECT 1 FROM "MotivationEventType" t WHERE t."profileId" = p."id" AND t."title" = 'Задача отмечена выполненной, а по факту нет');
