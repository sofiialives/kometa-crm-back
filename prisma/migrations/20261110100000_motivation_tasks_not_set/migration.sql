-- Новое автоправило мотивации: «Не расставил задачи на день до 10:00 по
-- Москве». Владелец включает его в профиле как любое другое автоправило
-- (mode auto, autoRule tasks_not_set, баллы, например -2) — проверяет его
-- cron в src/bot/index.js в 10:00 по будням.
ALTER TYPE "MotivationAutoRule" ADD VALUE IF NOT EXISTS 'tasks_not_set';
