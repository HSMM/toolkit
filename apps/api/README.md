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

## Что уже работает (итерация 2, после E3)

**Каркас:**
- Подключение к Postgres через pool (`pgx/v5`), graceful shutdown.
- Миграции через `golang-migrate` (7 миграций, см. `../../migrations/README.md`).
- Структурированные JSON-логи (`log/slog`) с автоматическим обогащением `user_id`, `role`, `session_id`, `request_id` после прохождения auth.

**Auth (E1 фундамент + E3.1/E3.2):**
- JWT access-токены HS256 на 15 мин, claims: `uid`, `email`, `role`, `sid`.
- Refresh-токены 32 байта, sha256-hash в БД, 30 дней sliding TTL, инвалидация при logout/блокировке.
- HMAC-подписанное OAuth state с встроенным TTL (10 мин) — без БД.
- SubjectLoader подгружает роль и список прямых подчинённых (контекстная роль «Руководитель», ТЗ 2.1).
- PromoteAdmin / DemoteAdmin с защитой от снятия с последнего активного админа.
- Authz-матрица для recording с режимами Allow / Deny / WithReason / WithNotify (ТЗ 4.1).

**Очередь (E3.4):**
- `queue.New(pool)` + `queue.NewRegistry()` → `queue.NewRunner(...)`.
- Атомарный Claim через `FOR UPDATE SKIP LOCKED`.
- Экспоненциальный backoff по неудачам (до 1 часа), dead-letter после `max_attempts`.
- Drain в shutdown — in-flight задачи освобождаются обратно в pending.

**WebSocket (E3.3):**
- Hub с per-user подписками, неблокирующий publish (drop-on-buffer-full с warning'ом).
- Auth требуется при upgrade. Ping каждые 30с.
- На клиенте — переподключение с backoff (логика на стороне фронта в E4).

**HTTP routes (E3.1):**
- `/healthz`, `/readyz`, `/version` — без авторизации.
- `/oauth/{login,callback,install,logout}` — заглушки 501, реальная реализация в E1.2.
- `/api/v1/*` — за `RequireAuth` + `RateLimitByUser`. Реализован `/api/v1/me`.
- `/api/v1/ws` — WebSocket events.
- `/admin/*` — за `RequireAuth` + `RequireRole(admin)`.

**OpenAPI спека (E3.5):** `api/openapi.yaml` — source of truth для генерации TS-клиента фронта.

**Тесты (E3.7):**
- `go test ./...` покрывает: JWT (issue/verify/expired/tampered/alg-none), OAuth state (round-trip/tamper/different-secret/malformed), Queue registry, middleware-helpers.
- Интеграционные тесты против реального PG — добавляются в каждом доменном модуле (E5/E6/E7) как `*_integration_test.go` (build tag `integration`).

## Что дальше (E1 implementation + E2 sync + E5/E6/E7/E8)

- **E1.2** — реализовать handlers `/oauth/{login,callback,install,logout}`: использовать `auth.OAuthStateMinter`, `auth.JWTIssuer`, `auth.SessionStore`, новый Bitrix24 client.
- **E1.4** — bootstrap-admin при первом входе: проверять `cfg.BootstrapAdmins` и вызывать `auth.PromoteAdmin`.
- **E1.8** — CLI `toolkit admin promote <email>` — добавить subcommand в `cmd/toolkit/main.go`.
- **E2.3** — Bitrix24 client (`internal/bitrix24`) с rate-limit backoff.
- **E2.4/E2.5** — handlers очереди для sync sotrudnikov / контактов.
- **E5/E6/E7/E8** — модули по плану декомпозиции.
