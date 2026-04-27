# apps/api

Backend Toolkit. Один Go-бинарник с тремя режимами запуска.

## Режимы

```bash
toolkit api       # HTTP/WS API-сервер
toolkit worker    # фоновый обработчик задач
toolkit migrate   # runner SQL-миграций
```

## Сборка локально

```bash
cd apps/api
go mod tidy
go build -o /tmp/toolkit ./cmd/toolkit
```

## Запуск в docker-compose

Из корня репозитория:

```bash
docker compose up -d
```

При старте контейнер `migrate` выполнит все накатываемые миграции (`up`), затем стартует `api` и `worker`. Порт API: `8080` внутри сети стека; наружу отдаётся через nginx (`web`) на `WEB_PORT` (по умолчанию 8080 хоста).

Проверки:

```bash
curl http://localhost:8080/api/healthz
# → {"status":"ok"}

curl http://localhost:8080/api/version
# → {"version":"0.0.1","mode":"api"}
```

## Миграции

```bash
# накатить все
docker compose run --rm migrate migrate --cmd=up

# откатить последнюю
docker compose run --rm migrate migrate --cmd=down --n=1

# текущая версия
docker compose run --rm migrate migrate --cmd=version

# силовой сброс "dirty" состояния
docker compose run --rm migrate migrate --cmd=force --version=1
```

## Структура

```
apps/api/
├── cmd/
│   └── toolkit/main.go            — единственная точка входа, парсит subcommand
├── api/
│   └── openapi.yaml               — контракт API (E3.5), source of truth для фронта
├── internal/
│   ├── config/                    — загрузка env-переменных + валидация
│   ├── logging/                   — slog JSON-logger
│   ├── db/                        — подключение к Postgres (pgx/v5)
│   ├── auth/                      — JWT, OAuth state, sessions, RBAC, authz
│   │   ├── types.go               — Subject, Role, Decision, ошибки
│   │   ├── jwt.go                 — issue/verify HS256, AccessTokenTTL=15m
│   │   ├── session.go             — refresh-токены (sha256-hash в БД, 30д сliding)
│   │   ├── oauth_state.go         — HMAC-подписанное state (10м TTL)
│   │   ├── rbac.go                — SubjectLoader + PromoteAdmin/DemoteAdmin
│   │   └── authz.go               — Allow/Deny/WithReason/WithNotify по матрице ТЗ 4.1
│   ├── queue/                     — Postgres-based job queue (FOR UPDATE SKIP LOCKED)
│   │   ├── queue.go               — Enqueue/Claim/Complete/Fail/Reschedule + retry с backoff
│   │   ├── registry.go            — Kind → HandlerFunc + ErrSkip
│   │   └── runner.go              — concurrency pool, polling, dead-letter
│   ├── ws/                        — WebSocket-канал событий (E3.3)
│   │   ├── hub.go                 — per-user подписки, Publish/Broadcast
│   │   └── handler.go             — /api/v1/ws (RequireAuth)
│   ├── server/                    — HTTP API (chi), маршруты, middleware
│   │   ├── server.go              — group'ы /healthz, /oauth, /api/v1, /admin
│   │   └── middleware/
│   │       ├── auth.go            — RequireAuth + RequireRole
│   │       ├── cors.go            — CORS для SPA
│   │       ├── ratelimit.go       — RateLimitGlobal (по IP) + RateLimitByUser
│   │       └── request_logger.go  — slog access-log с user_id/role/session_id/request_id
│   ├── worker/                    — entrypoint режима `toolkit worker` (использует queue)
│   └── migrate/                   — обёртка над golang-migrate
├── go.mod
├── Dockerfile                     — multi-stage, alpine, ~15 МБ
├── .dockerignore
└── README.md
```

## Что реализовано

**Каркас:**
- Подключение к Postgres через pool (`pgx/v5`), graceful shutdown.
- Миграции через `golang-migrate` (14 миграций, см. `../../migrations/README.md`).
- Структурированные JSON-логи (`log/slog`) с обогащением `user_id`, `role`, `session_id`, `request_id` после прохождения auth.

**Auth:**
- OAuth Bitrix24 (`internal/server/oauth`), refresh через `oauth.bitrix.info`, обмен code → tokens, upsert toolkit-юзера, bootstrap первого админа из `TOOLKIT_BOOTSTRAP_ADMINS`.
- JWT access-токены HS256 на 15 мин, claims: `uid`, `email`, `role`, `sid`.
- Refresh-токены 32 байта, sha256-hash в БД, 30 дней sliding TTL, инвалидация при logout/блокировке.
- HMAC-подписанное OAuth state с встроенным TTL (10 мин) — без БД.
- SubjectLoader подгружает роль и список прямых подчинённых (контекстная роль «Руководитель»).
- PromoteAdmin / DemoteAdmin с защитой от снятия с последнего активного админа.
- Authz-матрица для recording с режимами Allow / Deny / WithReason / WithNotify.

**Видеоконференции (`internal/meetings` + `internal/livekit`):**
- Тонкий Twirp-клиент к LiveKit без `server-sdk-go`: mint join token, EndRoom, ListParticipants, Composite Egress (MP4 grid), AudioRoomComposite (OGG), StopEgress.
- Webhook handler `/api/v1/livekit/webhook` (HMAC-проверка JWT + sha256 body), парсит `egress_started/ended/...`. Поля `int64` декодируются через `json.Number` (LiveKit protobuf JSON сериализует их как строки).
- `OnEgressEnded` через `SELECT FOR UPDATE` + ON CONFLICT по unique partial-индексу — идемпотентность при ретрае webhook'а; transcribe job ставится только на реальный INSERT.
- Guard от `EGRESS_ABORTED/FAILED/LIMIT_REACHED`: pointer'ы зачищаются, recording-row не создаётся (иначе UI показывал бы битые «Скачать» с 500 в `http.ServeContent`).
- Скачивание файлов через `http.ServeContent` с Range-поддержкой и Content-Disposition.
- Гостевые ссылки + lobby (admit/reject), long-poll status.

**Транскрибация (`internal/transcription` + `internal/gigaam`):**
- Polling-клиент GigaAM (`POST /stt/transcribe` → `GET /stt/result/{task_id}`).
- Хранение транскриптов с диалогом по каналам, аналитикой, экспортом TXT.
- Ручная загрузка аудио-файлов (`POST /transcripts/upload`) поверх той же job-pipeline.

**Bitrix24 sync пользователей (`internal/usersync` + `internal/bitrix`):**
- `bitrix.Client.RefreshAccessToken` через `oauth.bitrix.info`, `bitrix.Client.ListEmployees` через `user.get` с `FILTER USER_TYPE=employee + ACTIVE=Y`, постранично по 50.
- `usersync.Run` берёт самую свежую активную admin-сессию с непустым `bitrix_refresh_token_encrypted`, refresh'ит, UPSERT'ит в `"user"` через CTE с отслеживанием inserted/reactivated/updated, помечает отсутствующих как `deactivated_in_bitrix`.
- Endpoint `POST /api/v1/admin/users/sync/bitrix`. Запуск из UI; фоновый scheduler — отложен.

**System settings (`internal/sysset` + `internal/admin`):**
- KV-таблица `system_setting` (key/value JSONB).
- ReadRoutes (auth-required): `GET /modules`, `GET /phone/me` (свои SIP-креды).
- WriteRoutes (admin only): GET/PUT для `modules`, `smtp`, `phone` (с preserved-password логикой для пустых полей и password preservation per extension).
- Admin users: `GET/PUT/DELETE /admin/users`, `PUT /{id}/role` (с защитой от снятия последнего админа), `PUT /{id}/status`, `POST /sync/bitrix`.

**Очередь:**
- `queue.New(pool)` + `queue.NewRegistry()` → `queue.NewRunner(...)`.
- Атомарный Claim через `FOR UPDATE SKIP LOCKED`.
- Экспоненциальный backoff по неудачам (до 1 часа), dead-letter после `max_attempts`.
- Drain в shutdown — in-flight задачи освобождаются обратно в pending.

**WebSocket:**
- Hub с per-user подписками, неблокирующий publish (drop-on-buffer-full с warning'ом).
- Auth требуется при upgrade. Ping каждые 30с.

**HTTP routes:**
- `/healthz`, `/readyz`, `/version` — без авторизации.
- `/oauth/{login,callback,refresh,logout}` — реальная реализация.
- `/api/v1/livekit/webhook` — публичный (HMAC-валидация внутри handler'а; путь под `/api/v1` чтобы NPM проксировал).
- `/api/v1/*` — за `RequireAuth` + `RateLimitByUser`. `/api/v1/me`, `/api/v1/meetings/*`, `/api/v1/transcripts/*`, `/api/v1/ws`, `/api/v1/system-settings/*`.
- `/api/v1/admin/*` — `RequireRole(admin)`: users + system-settings WriteRoutes.
- `/admin/*` (legacy) — для прямых вызовов без NPM.

## Что не реализовано (известные пробелы MVP)

- Фоновое расписание Bitrix-sync (cron-job каждые N минут).
- Email-пайплайн (SMTP-настройки сохраняются, но `smtp.Send` не подключён; тест-кнопка → 501).
- Политики записи / GDPR / audit-log endpoints — данные пишутся, API для UI ещё нет.
- Реальная интеграция AMI для модуля «Мониторинг АТС».
- `/metrics` endpoint для Prometheus — Prometheus scrap'ит его, но он 404 (не блокирует запуск).
