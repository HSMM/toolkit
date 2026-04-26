# Toolkit

Корпоративный портал коммуникаций: софтфон, ВКС, транскрибация. См. документацию в `../toolkit-tz/`.

## Структура

```
toolkit/
├── apps/
│   ├── api/         — backend API + WS (Go)
│   ├── web/         — SPA (React + TS + Vite)
│   └── worker/      — фоновые задачи (тот же бинарник, что api, в worker-режиме)
├── migrations/      — SQL-миграции PostgreSQL
├── ops/
│   ├── coturn/      — конфиг STUN/TURN
│   ├── grafana/     — провижининг дашбордов
│   ├── livekit/     — конфиг LiveKit + Egress
│   ├── loki/        — конфиг Loki
│   ├── minio/       — инициализация бакетов
│   ├── nginx/       — внутренний web (статика + прокси на api)
│   ├── postgres/    — init SQL (роли, БД)
│   └── prometheus/  — конфиг метрик
├── docker-compose.yml       — полный стек на локальной машине
├── docker-compose.prod.yml  — prod-override для app-сервера
├── .env.example
└── Makefile
```

## Быстрый старт (локально)

Требуется: Docker 24+, Docker Compose v2, 8+ ГБ свободной RAM.

```bash
cp .env.example .env
# отредактировать .env, вписать секреты
docker compose up -d
```

После старта проверить:
- `http://localhost:8080` — заглушка веб-фронта
- `http://localhost:9001` — MinIO Console (admin: см. .env)
- `http://localhost:3001` — Grafana (admin: admin / см. .env)
- `http://localhost:7880` — LiveKit HTTP health
- `http://localhost:5601` — OpenSearch Dashboards (если включён)
- PostgreSQL: `localhost:5432` (см. .env)

## Production

На prod-сервере `10.10.0.17:/opt/toolkit` используется `docker-compose.prod.yml` как override:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

Отличия prod-override:
- LiveKit и coturn — в `network_mode: host` (а не через port-forward, т.к. нужен UDP-диапазон).
- `web` слушает только на приватном IP `10.10.0.17:18001` (а не `0.0.0.0`) — доступ через внешний NPM на `10.10.0.61`.
- Grafana доступна только с VPN/SSH-туннеля.
- Volumes маппятся на хост (`/opt/toolkit/data/*`).

## Production deployment

См. **`DEPLOYMENT.md`** — полный runbook для app-сервера `10.10.0.17`:
- топология (NPM 10.10.0.61 → app 10.10.0.17, DNS, файрвол)
- подготовка ОС, секреты, параметры NPM proxy host
- smoke-тесты, обновление, откат
- бэкап и восстановление
- мониторинг и алерты
- инцидент-плейбуки

## Состояние (итерация 1, эпик E0)

Сделано:
- E0.1, E0.3, E0.4 — структура монорепо, docker-compose со всеми сервисами, сети `edge`/`internal`, `.env.example`.
- E0.5–E0.10a — Postgres (роли + расширения), MinIO (3 бакета), OpenSearch, LiveKit + Egress, coturn, внутренний Nginx.
- E0.11 — Prometheus + Loki + Promtail, **4 дашборда Grafana** (System, PostgreSQL, LiveKit, API).
- E0.12 — **Grafana unified alerting** (9 правил), email-доставка через SMTP.
- E0.13 — **`DEPLOYMENT.md`** runbook с чек-листом подготовки окружения.
- **Бэкап PostgreSQL** — отдельный контейнер `postgres-backup` (pg_dump → MinIO bucket `backups`, retention 30 дней).

Отложено по решению:
- E0.2 — CI/CD (GitLab CI). Пока деплой ручной с `10.10.0.17`.
- E0.14 — отдельный staging стенд. Используется один app-сервер для prod.

`apps/api` — Go-каркас (cmd/toolkit с режимами api/worker/migrate). `apps/web` — placeholder (наполняется в эпике E4). Миграции БД появятся с E2.1.

## Следующие шаги

См. `../toolkit-tz/toolkit-decomposition.md`, раздел 7 «Первые 2 недели»:
- E1.1 — регистрация OAuth-приложения в Bitrix24.
- E2.1 — схема БД и первые миграции.
- POC-1 (FreePBX WebRTC), POC-2 (LiveKit Egress), POC-3 (GigaAM) — параллельно.
- E4.1–E4.3 — фронт-каркас (Vite + React + TS).
