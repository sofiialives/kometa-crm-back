-- Дробные баллы мотивации: премия и штраф теперь можно ставить не только
-- целым числом (например, 2.5 или -0.5). Переводим шкалу баллов в
-- MotivationEventType, MotivationEvent, MotivationReview и
-- MotivationMonthResult из Int в Float (double precision в Postgres).
-- Существующие целые значения конвертируются без потерь.

ALTER TABLE "MotivationEventType"
  ALTER COLUMN "prizePoints" TYPE DOUBLE PRECISION USING "prizePoints"::double precision,
  ALTER COLUMN "levelPoints" TYPE DOUBLE PRECISION USING "levelPoints"::double precision;

ALTER TABLE "MotivationEvent"
  ALTER COLUMN "prizePoints" TYPE DOUBLE PRECISION USING "prizePoints"::double precision,
  ALTER COLUMN "levelPoints" TYPE DOUBLE PRECISION USING "levelPoints"::double precision;

ALTER TABLE "MotivationReview"
  ALTER COLUMN "prizePoints" TYPE DOUBLE PRECISION USING "prizePoints"::double precision,
  ALTER COLUMN "levelPoints" TYPE DOUBLE PRECISION USING "levelPoints"::double precision;

ALTER TABLE "MotivationMonthResult"
  ALTER COLUMN "prizePoints" TYPE DOUBLE PRECISION USING "prizePoints"::double precision,
  ALTER COLUMN "levelPoints" TYPE DOUBLE PRECISION USING "levelPoints"::double precision;
