-- Этап 2 мотивации: автобаллы за задачи.
-- Владелец включает их в настройках с выбранной даты. До этого — выключены,
-- поэтому после выкладки ничего не начисляется само.
ALTER TABLE "MotivationSettings" ADD COLUMN "autoTasksFrom" TIMESTAMP(3);

-- Последняя разобранная ночным штрафом полночь: ночи до неё задним числом
-- не штрафуются.
ALTER TABLE "MotivationSettings" ADD COLUMN "overdueCheckedUntil" TIMESTAMP(3);

-- Записи по задаче ищутся при каждом закрытии и каждом ночном штрафе.
CREATE INDEX "MotivationEvent_taskId_idx" ON "MotivationEvent"("taskId");
