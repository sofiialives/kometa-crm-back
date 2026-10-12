-- Мотивация сотрудников: банк премии, баллы, профили должностей.
--
-- Миграция написана руками, как и все предыдущие. Сгенерированная Prisma
-- потащила бы сюда CREATE TYPE "TaskPriority" и ALTER TABLE "Task" ADD
-- COLUMN "priority": на проде это давно есть, а в истории миграций нет.
-- На бою такая миграция упала бы на "already exists" и уронила деплой всего
-- бэкенда — migrate deploy стоит в buildCommand.
--
-- DDL ниже сверен с prisma migrate diff от рабочей схемы: таблицы, индексы
-- и ключи совпадают один в один. Существующие таблицы не меняются, только
-- появляются новые и связи на "User" и "Client".
--
-- В конце миграции — стартовые данные: общая шкала, уровни работы, три
-- профиля из задания и назначение профилей тем, у кого должность понятна.
-- Без них вкладка открылась бы пустой и админу пришлось бы набивать всё
-- с нуля.

-- ---------------------------------------------------------------------------
-- Перечисления
-- ---------------------------------------------------------------------------

CREATE TYPE "MotivationEventMode" AS ENUM ('manual', 'auto');

CREATE TYPE "MotivationAutoRule" AS ENUM ('task_on_time', 'personal_task_on_time', 'task_overdue', 'personal_task_overdue');

CREATE TYPE "MotivationBankKind" AS ENUM ('start', 'top_up', 'write_off');

CREATE TYPE "MotivationBankReason" AS ENUM ('new_client', 'free_budget', 'other');

CREATE TYPE "MotivationEntryKind" AS ENUM ('event', 'adjustment', 'product');

-- ---------------------------------------------------------------------------
-- Профили и их условия
-- ---------------------------------------------------------------------------

CREATE TABLE "MotivationProfile" (
    "id"                  TEXT NOT NULL,
    "title"               TEXT NOT NULL,
    "startBankCents"      INTEGER NOT NULL DEFAULT 0,
    "customScale"         BOOLEAN NOT NULL DEFAULT false,
    "workHints"           JSONB NOT NULL DEFAULT '{}',
    "conditionsUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"           TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MotivationProfile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MotivationEventType" (
    "id"          TEXT NOT NULL,
    "profileId"   TEXT NOT NULL,
    "title"       TEXT NOT NULL,
    "example"     TEXT,
    "prizePoints" INTEGER NOT NULL,
    "levelPoints" INTEGER NOT NULL,
    "mode"        "MotivationEventMode" NOT NULL DEFAULT 'manual',
    "autoRule"    "MotivationAutoRule",
    "systemKey"   TEXT,
    "enabled"     BOOLEAN NOT NULL DEFAULT true,
    "position"    INTEGER NOT NULL DEFAULT 0,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MotivationEventType_pkey" PRIMARY KEY ("id")
);

-- Уровни шкалы премии. Пустой "profileId" — общая шкала агентства.
CREATE TABLE "MotivationPrizeLevel" (
    "id"        TEXT NOT NULL,
    "profileId" TEXT,
    "position"  INTEGER NOT NULL,
    "threshold" INTEGER NOT NULL,
    "percent"   INTEGER NOT NULL,
    CONSTRAINT "MotivationPrizeLevel_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MotivationWorkLevel" (
    "id"        TEXT NOT NULL,
    "position"  INTEGER NOT NULL,
    "title"     TEXT NOT NULL,
    "minPoints" INTEGER NOT NULL,
    "hint"      TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MotivationWorkLevel_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MotivationSettings" (
    "id"                   TEXT NOT NULL DEFAULT 'global',
    "overduePenaltyCap"    INTEGER NOT NULL DEFAULT 10,
    "personalTaskDailyCap" INTEGER NOT NULL DEFAULT 2,
    "notifyBank"           BOOLEAN NOT NULL DEFAULT true,
    "notifyPoints"         BOOLEAN NOT NULL DEFAULT true,
    "updatedAt"            TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MotivationSettings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MotivationAssignment" (
    "id"          TEXT NOT NULL,
    "userId"      TEXT NOT NULL,
    "profileId"   TEXT NOT NULL,
    "from"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MotivationAssignment_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------------
-- Журналы
-- ---------------------------------------------------------------------------

-- Деньги в центах целым числом, как на доске клиентов: доллары с центами в
-- JavaScript складываются с ошибкой.
CREATE TABLE "MotivationBankEntry" (
    "id"          TEXT NOT NULL,
    "userId"      TEXT NOT NULL,
    "kind"        "MotivationBankKind" NOT NULL,
    "reason"      "MotivationBankReason",
    "amountCents" INTEGER NOT NULL,
    "clientId"    TEXT,
    "clientName"  TEXT,
    "comment"     TEXT,
    "occurredAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dedupeKey"   TEXT,
    "createdById" TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MotivationBankEntry_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MotivationEvent" (
    "id"            TEXT NOT NULL,
    "userId"        TEXT NOT NULL,
    "profileId"     TEXT,
    "eventTypeId"   TEXT,
    "kind"          "MotivationEntryKind" NOT NULL,
    "mode"          "MotivationEventMode" NOT NULL,
    "title"         TEXT NOT NULL,
    "prizePoints"   INTEGER NOT NULL,
    "levelPoints"   INTEGER NOT NULL,
    "taskId"        TEXT,
    "taskTitle"     TEXT,
    "clientId"      TEXT,
    "clientName"    TEXT,
    "comment"       TEXT,
    "occurredAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dedupeKey"     TEXT,
    "createdById"   TEXT,
    "cancelledAt"   TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelReason"  TEXT,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MotivationEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MotivationSeen" (
    "userId"       TEXT NOT NULL,
    "bankSeenAt"   TIMESTAMP(3),
    "eventsSeenAt" TIMESTAMP(3),
    "updatedAt"    TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MotivationSeen_pkey" PRIMARY KEY ("userId")
);

-- ---------------------------------------------------------------------------
-- Индексы
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX "MotivationProfile_title_key" ON "MotivationProfile"("title");

CREATE INDEX "MotivationEventType_profileId_position_idx" ON "MotivationEventType"("profileId", "position");

-- Одно автоправило и одна служебная метка на профиль. Ручные события эти
-- поля не заполняют, а пустые значения уникальность не нарушают.
CREATE UNIQUE INDEX "MotivationEventType_profileId_autoRule_key" ON "MotivationEventType"("profileId", "autoRule");
CREATE UNIQUE INDEX "MotivationEventType_profileId_systemKey_key" ON "MotivationEventType"("profileId", "systemKey");

CREATE INDEX "MotivationPrizeLevel_profileId_position_idx" ON "MotivationPrizeLevel"("profileId", "position");

CREATE UNIQUE INDEX "MotivationWorkLevel_position_key" ON "MotivationWorkLevel"("position");

-- Текущий профиль — последняя запись с "from" не позже нужного момента.
CREATE INDEX "MotivationAssignment_userId_from_idx" ON "MotivationAssignment"("userId", "from");

-- Обе выборки журналов — «записи сотрудника за месяц».
-- Ключи повторов: стартовая сумма один раз за месяц, одно нажатие формы —
-- одна запись на сотрудника, одно автособытие — одно начисление.
CREATE UNIQUE INDEX "MotivationBankEntry_dedupeKey_key" ON "MotivationBankEntry"("dedupeKey");
CREATE INDEX "MotivationBankEntry_userId_occurredAt_idx" ON "MotivationBankEntry"("userId", "occurredAt");

CREATE UNIQUE INDEX "MotivationEvent_dedupeKey_key" ON "MotivationEvent"("dedupeKey");
CREATE INDEX "MotivationEvent_userId_occurredAt_idx" ON "MotivationEvent"("userId", "occurredAt");

-- ---------------------------------------------------------------------------
-- Внешние ключи
-- ---------------------------------------------------------------------------

-- Условия профиля живут и умирают вместе с ним.
ALTER TABLE "MotivationEventType" ADD CONSTRAINT "MotivationEventType_profileId_fkey"
    FOREIGN KEY ("profileId") REFERENCES "MotivationProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MotivationPrizeLevel" ADD CONSTRAINT "MotivationPrizeLevel_profileId_fkey"
    FOREIGN KEY ("profileId") REFERENCES "MotivationProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Сотрудников не удаляют, а деактивируют, поэтому RESTRICT на "User" ничего
-- не ломает и бережёт историю.
ALTER TABLE "MotivationAssignment" ADD CONSTRAINT "MotivationAssignment_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Профиль, который кому-то назначался, удалить нельзя: по нему посчитано
-- чьё-то прошлое. Понятное сообщение выдаёт сервис до того, как дойдёт до базы.
ALTER TABLE "MotivationAssignment" ADD CONSTRAINT "MotivationAssignment_profileId_fkey"
    FOREIGN KEY ("profileId") REFERENCES "MotivationProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MotivationAssignment" ADD CONSTRAINT "MotivationAssignment_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MotivationBankEntry" ADD CONSTRAINT "MotivationBankEntry_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- SET NULL на клиента: название клиента скопировано в запись, история
-- переживёт его удаление.
ALTER TABLE "MotivationBankEntry" ADD CONSTRAINT "MotivationBankEntry_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MotivationBankEntry" ADD CONSTRAINT "MotivationBankEntry_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MotivationEvent" ADD CONSTRAINT "MotivationEvent_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Название и баллы события скопированы в запись, поэтому профиль и событие
-- профиля можно потом убрать, не трогая уже начисленное.
ALTER TABLE "MotivationEvent" ADD CONSTRAINT "MotivationEvent_profileId_fkey"
    FOREIGN KEY ("profileId") REFERENCES "MotivationProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MotivationEvent" ADD CONSTRAINT "MotivationEvent_eventTypeId_fkey"
    FOREIGN KEY ("eventTypeId") REFERENCES "MotivationEventType"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MotivationEvent" ADD CONSTRAINT "MotivationEvent_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MotivationEvent" ADD CONSTRAINT "MotivationEvent_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MotivationEvent" ADD CONSTRAINT "MotivationEvent_cancelledById_fkey"
    FOREIGN KEY ("cancelledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MotivationSeen" ADD CONSTRAINT "MotivationSeen_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Стартовые данные
-- ---------------------------------------------------------------------------
--
-- Цифры — из задания. Там же сказано, что это основа, которую админ потом
-- подгонит под реальную работу агентства: всё ниже меняется в «Настройках».
-- Идентификаторы заданы руками, чтобы на любой базе они были одинаковыми.
--
-- Время везде — в UTC. Колонки здесь без часового пояса, и Prisma читает
-- их как UTC, а CURRENT_TIMESTAMP пишет время в поясе самой базы. На базе с
-- московским поясом назначение профиля оказалось бы на три часа в будущем и
-- до вечера не действовало бы — так и случилось при проверке на локальной
-- базе. Поэтому явные значения — now() AT TIME ZONE 'UTC', а для колонок со
-- значением по умолчанию пояс сессии переключается на UTC до конца миграции.
SET TIME ZONE 'UTC';

INSERT INTO "MotivationSettings" ("id", "overduePenaltyCap", "personalTaskDailyCap", "notifyBank", "notifyPoints", "updatedAt")
VALUES ('global', 10, 2, true, true, (now() AT TIME ZONE 'UTC'));

-- Общая шкала премии: пять уровней по 20 баллов. Сумма растёт быстрее к
-- концу шкалы, последний уровень — весь банк.
INSERT INTO "MotivationPrizeLevel" ("id", "profileId", "position", "threshold", "percent") VALUES
    ('mlvl_global_1', NULL, 1, 20, 15),
    ('mlvl_global_2', NULL, 2, 40, 30),
    ('mlvl_global_3', NULL, 3, 60, 50),
    ('mlvl_global_4', NULL, 4, 80, 75),
    ('mlvl_global_5', NULL, 5, 100, 100);

-- Уровни работы. Названия звучат как движение вперёд, а не как приговор;
-- последний начинается с 80 баллов и совпадает с четвёртым уровнем премии.
INSERT INTO "MotivationWorkLevel" ("id", "position", "title", "minPoints", "hint", "updatedAt") VALUES
    ('mwork_1', 1, 'Разгоняемся', 0,
     'Закрывайте задачи в срок: каждая добавляет баллы. Если были просрочки, их стоит закрыть в первую очередь', (now() AT TIME ZONE 'UTC')),
    ('mwork_2', 2, 'Хороший темп', 30,
     'Вы на верном пути. Чтобы выйти на новый уровень, добавьте объём и не допускайте просрочек', (now() AT TIME ZONE 'UTC')),
    ('mwork_3', 3, 'Сильный результат', 60,
     'Сильная работа. До уровня «Отлично» осталось немного: следите за сроками и качеством', (now() AT TIME ZONE 'UTC')),
    ('mwork_4', 4, 'Отлично', 80,
     'Вы в лучшей зоне месяца. Держите темп', (now() AT TIME ZONE 'UTC'));

INSERT INTO "MotivationProfile" ("id", "title", "updatedAt") VALUES
    ('mprof_developer', 'Разработчик', (now() AT TIME ZONE 'UTC')),
    ('mprof_designer', 'Дизайнер', (now() AT TIME ZONE 'UTC')),
    ('mprof_targeting', 'Таргетолог', (now() AT TIME ZONE 'UTC'));

-- События профилей. По задачам у каждого профиля одно автособытие «в срок»:
-- типов задач в CRM нет, и система не отличит макет от отчёта, поэтому у
-- таргетолога запуск кампании и сдача отчёта объединены в одно событие.
--
-- Сверх задания во всех профилях есть:
--   • личные задачи — отдельным событием с меньшими баллами и дневным
--     потолком, потому что их человек ставит себе сам;
--   • просроченная личная задача — штраф один раз: ночная уборка CRM её
--     удаляет, и «каждого следующего дня» у неё просто не бывает;
--   • «Был на созвоне» — заказчик сказал на созвоне, что баллы будут и за
--     это. Отмечает руководитель: CRM знает, кого позвали, но не знает,
--     кто пришёл.
INSERT INTO "MotivationEventType"
    ("id", "profileId", "title", "example", "prizePoints", "levelPoints", "mode", "autoRule", "systemKey", "position", "updatedAt")
VALUES
    ('mevt_dev_on_time', 'mprof_developer', 'Задача закрыта успешно и в срок',
     'Задача из Иерархии закрыта до дедлайна', 2, 2, 'auto', 'task_on_time', NULL, 1, (now() AT TIME ZONE 'UTC')),
    ('mevt_dev_personal_on_time', 'mprof_developer', 'Личная задача закрыта в срок',
     'Задача, которую вы поставили себе сами, закрыта до дедлайна', 1, 1, 'auto', 'personal_task_on_time', NULL, 2, (now() AT TIME ZONE 'UTC')),
    ('mevt_dev_overdue', 'mprof_developer', 'Просрочка дедлайна',
     'Задача из Иерархии не закрыта к дедлайну: штраф за каждый день просрочки', -2, -2, 'auto', 'task_overdue', NULL, 3, (now() AT TIME ZONE 'UTC')),
    ('mevt_dev_personal_overdue', 'mprof_developer', 'Личная задача просрочена',
     'Личная задача не закрыта к дедлайну: штраф один раз', -2, -2, 'auto', 'personal_task_overdue', NULL, 4, (now() AT TIME ZONE 'UTC')),
    ('mevt_dev_rework', 'mprof_developer', 'Задача возвращена на доработку из-за ошибки разработчика',
     'Руководитель вернул задачу: сделано не так, как договорились', -3, -3, 'manual', NULL, NULL, 5, (now() AT TIME ZONE 'UTC')),
    ('mevt_dev_release', 'mprof_developer', 'Релиз прошёл 7 дней без критических ошибок',
     'Неделю после выкладки не было ни одной критичной ошибки', 3, 3, 'manual', NULL, NULL, 6, (now() AT TIME ZONE 'UTC')),
    ('mevt_dev_call', 'mprof_developer', 'Был на созвоне',
     'Руководитель отметил, что вы были на созвоне с командой или клиентом', 1, 1, 'manual', NULL, NULL, 7, (now() AT TIME ZONE 'UTC')),
    ('mevt_dev_product', 'mprof_developer', 'Клиент купил дополнительный продукт',
     'Клиент, с которым вы работали, заказал у агентства ещё одну услугу', 10, 10, 'manual', NULL, 'client_product', 8, (now() AT TIME ZONE 'UTC')),

    ('mevt_des_on_time', 'mprof_designer', 'Макет сдан в срок',
     'Задача по макету из Иерархии закрыта до дедлайна', 2, 2, 'auto', 'task_on_time', NULL, 1, (now() AT TIME ZONE 'UTC')),
    ('mevt_des_personal_on_time', 'mprof_designer', 'Личная задача закрыта в срок',
     'Задача, которую вы поставили себе сами, закрыта до дедлайна', 1, 1, 'auto', 'personal_task_on_time', NULL, 2, (now() AT TIME ZONE 'UTC')),
    ('mevt_des_overdue', 'mprof_designer', 'Просрочка дедлайна',
     'Задача из Иерархии не закрыта к дедлайну: штраф за каждый день просрочки', -2, -2, 'auto', 'task_overdue', NULL, 3, (now() AT TIME ZONE 'UTC')),
    ('mevt_des_personal_overdue', 'mprof_designer', 'Личная задача просрочена',
     'Личная задача не закрыта к дедлайну: штраф один раз', -2, -2, 'auto', 'personal_task_overdue', NULL, 4, (now() AT TIME ZONE 'UTC')),
    ('mevt_des_first_time', 'mprof_designer', 'Макет принят клиентом с первого раза, без правок',
     'Клиент утвердил макет сразу, без единой правки', 3, 3, 'manual', NULL, NULL, 5, (now() AT TIME ZONE 'UTC')),
    ('mevt_des_rounds', 'mprof_designer', 'Больше двух кругов правок по вине дизайнера',
     'Макет переделывали третий раз из-за ошибок в самом макете', -2, -2, 'manual', NULL, NULL, 6, (now() AT TIME ZONE 'UTC')),
    ('mevt_des_call', 'mprof_designer', 'Был на созвоне',
     'Руководитель отметил, что вы были на созвоне с командой или клиентом', 1, 1, 'manual', NULL, NULL, 7, (now() AT TIME ZONE 'UTC')),
    ('mevt_des_product', 'mprof_designer', 'Клиент купил дополнительный продукт',
     'Клиент, с которым вы работали, заказал у агентства ещё одну услугу', 10, 10, 'manual', NULL, 'client_product', 8, (now() AT TIME ZONE 'UTC')),

    ('mevt_trg_on_time', 'mprof_targeting', 'Кампания запущена или отчёт сдан в срок',
     'Задача из Иерархии закрыта до дедлайна: запуск кампании или отчёт клиенту', 2, 2, 'auto', 'task_on_time', NULL, 1, (now() AT TIME ZONE 'UTC')),
    ('mevt_trg_personal_on_time', 'mprof_targeting', 'Личная задача закрыта в срок',
     'Задача, которую вы поставили себе сами, закрыта до дедлайна', 1, 1, 'auto', 'personal_task_on_time', NULL, 2, (now() AT TIME ZONE 'UTC')),
    ('mevt_trg_overdue', 'mprof_targeting', 'Просрочка дедлайна',
     'Задача из Иерархии не закрыта к дедлайну: штраф за каждый день просрочки', -2, -2, 'auto', 'task_overdue', NULL, 3, (now() AT TIME ZONE 'UTC')),
    ('mevt_trg_personal_overdue', 'mprof_targeting', 'Личная задача просрочена',
     'Личная задача не закрыта к дедлайну: штраф один раз', -2, -2, 'auto', 'personal_task_overdue', NULL, 4, (now() AT TIME ZONE 'UTC')),
    ('mevt_trg_goal', 'mprof_targeting', 'Цель кампании за месяц выполнена',
     'Кампания набрала то количество заявок или продаж, о котором договорились', 5, 5, 'manual', NULL, NULL, 5, (now() AT TIME ZONE 'UTC')),
    ('mevt_trg_call', 'mprof_targeting', 'Был на созвоне',
     'Руководитель отметил, что вы были на созвоне с командой или клиентом', 1, 1, 'manual', NULL, NULL, 6, (now() AT TIME ZONE 'UTC')),
    ('mevt_trg_product', 'mprof_targeting', 'Клиент купил дополнительный продукт',
     'Клиент, с которым вы работали, заказал у агентства ещё одну услугу', 10, 10, 'manual', NULL, 'client_product', 7, (now() AT TIME ZONE 'UTC'));

-- Профили тем, у кого должность понятна по названию. Остальных назначит
-- админ во вкладке. Банк и баллы бывают только у рядовых сотрудников, так
-- что руководители и админ сюда не попадают.
--
-- Ищем по куску слова без первой буквы: «изайн», «азраб», «аргет». Регистр
-- кириллицы в сравнении зависит от локали базы, а без первой буквы его и
-- сравнивать не нужно — «Дизайнер» и «веб-дизайнер» находятся одинаково.
INSERT INTO "MotivationAssignment" ("id", "userId", "profileId", "from", "createdAt")
SELECT
    'masg_' || u."id",
    u."id",
    CASE
        WHEN u."position" LIKE '%изайн%' THEN 'mprof_designer'
        WHEN u."position" LIKE '%азраб%' THEN 'mprof_developer'
        ELSE 'mprof_targeting'
    END,
    (now() AT TIME ZONE 'UTC'),
    (now() AT TIME ZONE 'UTC')
FROM "User" u
WHERE u."role" = 'staff'
  AND u."active" = true
  AND (u."position" LIKE '%изайн%' OR u."position" LIKE '%азраб%' OR u."position" LIKE '%аргет%');
