# migrations

SQL-миграции PostgreSQL для Toolkit.

## Формат

Используется **golang-migrate**. Файлы: `NNNNNN_<name>.up.sql` и `NNNNNN_<name>.down.sql`.

Миграции выполняются контейнером `migrate` при старте стека (идемпотентно). Для ручного управления:

```bash
docker compose run --rm api ./toolkit migrate --cmd=up           # применить все pending
docker compose run --rm api ./toolkit migrate --cmd=down --steps=1   # откатить одну
docker compose run --rm api ./toolkit migrate --cmd=version      # текущая версия
```

## Текущий состав (E2.1, итерация 2)

| # | Файл | Что |
|---|---|---|
| 000001 | `users_and_sessions` | `user`, `role_assignment`, `session`, `audit_log` + триггер `set_updated_at()` |
| 000002 | `contacts_jobs_retention` | `contact_cache` (с GIN на phones), `job` (очередь SKIP LOCKED), `retention_policy` (с seed-значениями из ТЗ 4.2) |
| 000003 | `calls` | `call` (CDR-импорт из FreePBX, идемпотентность по `freepbx_cdr_id`) |
| 000004 | `meetings_participants` | `meeting`, `participant` (для ВКС, привязка к LiveKit identity) |
| 000005 | `recordings` | `recording` (полиморфная: call / meeting_composite / meeting_per_track) с retention |
| 000006 | `transcripts` | `transcript` (с `gigaam_task_id`, `engine_metadata`), `transcript_segment`, `transcript_revision` |
| 000007 | `gdpr_softphone` | `gdpr_request` (с SLA), `softphone_status` |

Покрывает раздел 3 архитектурного документа (`../../toolkit-tz/toolkit-architecture.md`) — все основные сущности модели данных.

## Что НЕ в миграциях (намеренно)

- **Шаблоны индексов OpenSearch** — это не Postgres, описывается в `apps/api/internal/search/templates/` (создаётся в E7.4).
- **Bitrix24 app token** — статический secret из `.env`, не хранится в БД.
- **OAuth login state** — короткоживущий, в HttpOnly cookie на стороне клиента, не в БД.

## Соглашения по стилю

- Все таблицы — singular snake_case (`user`, `session`, `recording`).
- PK — UUID `gen_random_uuid()` для бизнес-сущностей; `BIGSERIAL` для high-volume логов (`audit_log`, `job`).
- `TIMESTAMPTZ` для всех временных меток.
- `created_at` / `updated_at` — дефолт `NOW()`, `updated_at` через триггер `set_updated_at()` (создан в 000001, переиспользуется).
- Имена индексов: `<table>_<purpose>_idx` или `<table>_<columns>_uniq`.
- `IF NOT EXISTS` / `IF EXISTS` везде — миграции идемпотентны.
- Комментарии по-русски с разделителями `-- ===...`, ссылки на разделы ТЗ/архитектуры.
- CHECK-констрейнты inline в DDL.

## Как добавить новую миграцию

```bash
# Следующий свободный номер
LAST=$(ls migrations/*.up.sql | sort -V | tail -1 | sed 's/.*\(00[0-9]*\)_.*/\1/')
NEXT=$(printf "%06d" $((10#$LAST + 1)))
NAME=  # <- придумать короткое имя в snake_case

touch migrations/${NEXT}_${NAME}.up.sql
touch migrations/${NEXT}_${NAME}.down.sql
```

После добавления — `make up` или `docker compose run --rm migrate` прогонит её.
