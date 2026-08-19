# KOMETA CRM — Backend

Node.js + Express + MongoDB (Mongoose). Слоистая архитектура: routes → middlewares → controllers → services → models.

## Запуск

cp .env.example .env
npm install
npm run dev

Нужен локальный MongoDB (или MONGO_URI на Atlas).

## Архитектура

src/
  config/       env.js, db.js — конфиг и подключение к базе
  models/       Mongoose-схемы: User, Department, Work, Task
  schemas/      zod-схемы валидации входящих запросов (body/query/params)
  middlewares/  validate (zod), authenticate/authorize (JWT + роли), error handler
  services/     бизнес-логика и правила доступа, работают с models
  controllers/  handlers: тонкий слой, вызывает services, формирует ответ
  routes/       маршруты: собирают authenticate → authorize → validate → controller
  jobs/         cron: очистка выполненных и просроченных задач в конце дня
  utils/        ApiError, asyncHandler, jwt
  app.js        сборка express-приложения (middlewares + routes)
  server.js     точка входа: подключение к БД, cron, запуск сервера

Правило слоёв: routes не лезут в models напрямую, только через services.
Controllers не содержат бизнес-логику, только оркестрацию.

## Модель данных

User        — name, email, passwordHash/googleId, role: admin|lead|staff, departmentId, active
Department  — name, leadId → User
Work        — clientName, title, departmentId, createdBy, assignees[], status
Task        — title, deadline (Date), status: today|progress|done, ownerId, departmentId, workId?

## Роли и видимость (совпадает с фронтом)

- admin — видит все отделы, все работы, все задачи; единственный, кто создаёт отделы,
  назначает роли и увольняет (POST /users/:id/deactivate — обнуляет department и role, active=false).
- lead — главный отдела: создаёт работы и назначает на них сотрудников своего отдела,
  видит задачи всего отдела (GET /tasks без scope).
- staff — видит и создаёт только свои задачи.

Ключевая точка правды по видимости задач: services/task.service.js → listTasksVisibleTo().

## Жизненный цикл задачи

Создаётся со статусом today и дедлайном на сегодня. Переходит today → progress → done
через PATCH /tasks/:id/status. Поле overdue в ответе GET /tasks вычисляется на лету
(services/task.service.js → isOverdue). В полночь cron (jobs/clearFinishedTasks.job.js)
удаляет все задачи в статусе done и все просроченные незакрытые — соответствует
правилу «висит до конца дня, потом исчезает».

## Auth

JWT access (15 мин) + refresh (30 дней). Google — id_token с фронта проверяется через
google-auth-library (services/auth.service.js → loginWithGoogle). Учти: для входа через
Google пользователь должен уже существовать в базе (заводит админ) — самостоятельная
регистрация закрыта, доступ выдаёт администратор.

## API

POST   /api/auth/login          { email, password }
POST   /api/auth/google         { idToken }
POST   /api/auth/refresh        { refreshToken }
POST   /api/auth/logout
GET    /api/auth/me             (auth)

GET    /api/users               (auth: admin|lead)
POST   /api/users               (auth: admin)
PATCH  /api/users/:id           (auth: admin)
POST   /api/users/:id/deactivate (auth: admin)

GET    /api/departments         (auth)
POST   /api/departments         (auth: admin)
PATCH  /api/departments/:id     (auth: admin)

GET    /api/works               (auth, отфильтровано по роли)
POST   /api/works               (auth: admin|lead)
PATCH  /api/works/:id           (auth: admin|lead своего отдела)

GET    /api/tasks               (auth, отфильтровано по роли; ?scope=mine|department|all для admin)
POST   /api/tasks               (auth)
PATCH  /api/tasks/:id/status    (auth)
DELETE /api/tasks/:id           (auth)

## Дальше

- Индексы под нагрузку — уже проставлены на User.departmentId, Task.ownerId+status, Task.departmentId+status.
- Тесты — пока нет, структура позволяет мокать services и тестировать controllers отдельно.
- Если понадобится Postgres/Prisma вместо Mongo — меняются только models/ и запросы в services/,
  остальные слои не трогаем.
