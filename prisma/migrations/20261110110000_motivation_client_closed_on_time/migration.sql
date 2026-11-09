-- Новое автоправило мотивации для руководителей отделов: «Все задачи по
-- клиенту закрыты в срок» (client_closed_on_time) — срабатывает, когда
-- закрывается работа и все её задачи из Иерархии закрыты не позже срока.
-- Проверяет chargeClientClosedOnTime в autoTasks.service.js, вызывается
-- из work.service.js при смене статуса работы на «done».
ALTER TYPE "MotivationAutoRule" ADD VALUE IF NOT EXISTS 'client_closed_on_time';
