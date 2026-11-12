-- Правки от 12.11: автоматические правила по задачам больше не ждут
-- решения владельца — review=false, баллы начисляются или снимаются сразу
-- (бот раньше всё равно клал их во «Ждут решения», теперь это просто
-- отчёт владельцу). Штраф за просрочку личной задачи и задачи из Иерархии
-- — новые суммы: -3 и -20 (было -2 и -2). Старые значения сохраняем в
-- "_AutoEventsBackup12" на случай отката.
CREATE TABLE "_AutoEventsBackup12" ("id" TEXT PRIMARY KEY, "review" BOOLEAN NOT NULL, "prizePoints" DOUBLE PRECISION NOT NULL, "levelPoints" DOUBLE PRECISION NOT NULL);
INSERT INTO "_AutoEventsBackup12" ("id", "review", "prizePoints", "levelPoints")
SELECT "id", "review", "prizePoints", "levelPoints" FROM "MotivationEventType"
WHERE "autoRule" IN ('task_on_time', 'personal_task_on_time', 'personal_task_overdue', 'task_overdue');

UPDATE "MotivationEventType" SET "review" = false, "updatedAt" = CURRENT_TIMESTAMP
WHERE "autoRule" IN ('task_on_time', 'personal_task_on_time', 'personal_task_overdue', 'task_overdue');

UPDATE "MotivationEventType" SET "prizePoints" = -3, "levelPoints" = -3, "updatedAt" = CURRENT_TIMESTAMP
WHERE "autoRule" = 'personal_task_overdue';

UPDATE "MotivationEventType" SET "prizePoints" = -20, "levelPoints" = -20, "updatedAt" = CURRENT_TIMESTAMP
WHERE "autoRule" = 'task_overdue';

-- «Нет ответа агенту 45 минут» теперь списывается автоматически ботом
-- (rounds.js, penalizeNoReply) по systemKey, сумма -5 (было -3).
UPDATE "MotivationEventType" SET "systemKey" = 'agent_no_reply', "prizePoints" = -5, "levelPoints" = -5, "updatedAt" = CURRENT_TIMESTAMP
WHERE "title" = 'Больше 45 минут нет ответа агенту без предупреждения' AND "systemKey" IS NULL;
