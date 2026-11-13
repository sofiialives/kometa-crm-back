-- 13.11 в 9:00 бот снял баллы за просрочку по задачам, где решение уже было:
-- Ян нажал «Не снимать» или заявка ждала его, либо штраф по этой задаче уже
-- снимали раньше под старым ключом по ночи (ключ сменился на «once» 12.11).
-- Такие штрафы отменяем от имени системы. Сотрудник, который получил
-- сообщение о штрафе, получит сообщение об отмене.
-- Откат: checks/refund-overdue-13nov-down.sql (берёт ids из копии ниже).
CREATE TABLE "_RefundOverdue13Nov" ("id" TEXT PRIMARY KEY);

INSERT INTO "_RefundOverdue13Nov" ("id")
SELECT e."id"
FROM "MotivationEvent" e
WHERE e."cancelledAt" IS NULL
  AND e."taskId" IS NOT NULL
  AND e."dedupeKey" LIKE 'auto:%:once'
  AND (e."dedupeKey" LIKE 'auto:task\_overdue:%' ESCAPE '\' OR e."dedupeKey" LIKE 'auto:personal\_task\_overdue:%' ESCAPE '\')
  AND e."createdAt" >= TIMESTAMP '2026-11-12 00:00:00'
  AND (
    EXISTS (
      SELECT 1 FROM "MotivationReview" r
      WHERE r."taskId" = e."taskId"
        AND r."status" <> 'withdrawn'
        AND e."dedupeKey" LIKE 'auto:' || r."rule"::text || ':%'
    )
    OR EXISTS (
      SELECT 1 FROM "MotivationEvent" o
      WHERE o."id" <> e."id"
        AND o."taskId" = e."taskId"
        AND o."createdAt" < e."createdAt"
        AND o."dedupeKey" LIKE split_part(e."dedupeKey", ':', 1) || ':' || split_part(e."dedupeKey", ':', 2) || ':' || split_part(e."dedupeKey", ':', 3) || ':%'
    )
  );

UPDATE "MotivationEvent"
SET "cancelledAt" = CURRENT_TIMESTAMP,
    "cancelReason" = 'Отменено: по этой задаче просрочку уже решали или штраф уже снимали'
WHERE "id" IN (SELECT "id" FROM "_RefundOverdue13Nov");
