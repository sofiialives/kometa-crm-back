-- Участники звонка. Снова пишем миграцию руками, а не генератором: в
-- истории миграций по-прежнему нет Task.priority, и сгенерированный файл
-- потащил бы её за собой, уронив деплой бэкенда на проде.
--
-- Здесь только новая связующая таблица. Ни Call, ни User не меняются:
-- связь «многие ко многим» живёт отдельной таблицей, колонок у
-- существующих сущностей не прибавляется.
--
-- Имена и форма таблицы — те, что Prisma ожидает от неявной связи
-- многие-ко-многим: _<ИмяСвязи>, колонки A и B в алфавитном порядке
-- моделей (Call, потом User).

CREATE TABLE "_CallParticipants" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

CREATE UNIQUE INDEX "_CallParticipants_AB_unique" ON "_CallParticipants"("A", "B");
CREATE INDEX "_CallParticipants_B_index" ON "_CallParticipants"("B");

-- CASCADE с обеих сторон: удалили звонок — записи о его участниках не
-- нужны; удалили пользователя — он просто исчезает из списков, звонки
-- остальных при этом целы.
ALTER TABLE "_CallParticipants" ADD CONSTRAINT "_CallParticipants_A_fkey"
    FOREIGN KEY ("A") REFERENCES "Call"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "_CallParticipants" ADD CONSTRAINT "_CallParticipants_B_fkey"
    FOREIGN KEY ("B") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
