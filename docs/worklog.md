# Worklog

Журнал технических задач по проекту Toolkit. Сюда заносим существенные изменения,
диагностику прод-инцидентов и важные решения, чтобы история была видна не только
в чате и `git log`.

## 2026-04-26 — Лицензирование публичного репозитория

**Задача:** добавить лицензию продукта с учётом используемого open-source стека и
опубликовать изменения на GitHub.

**Сделано:**
- Добавлена лицензия Apache License 2.0 для кода Toolkit.
- Добавлен `NOTICE` с границами по брендам, внешним системам и сторонним ПО.
- Добавлен `THIRD_PARTY_NOTICES.md` со сводкой Go/npm-зависимостей, runtime-сервисов
  и контейнерных образов.
- В `README.md` добавлен раздел “Лицензия”.
- В `apps/web/package.json` добавлено поле `"license": "Apache-2.0"`.

**Коммит:** `e95280a Add Apache license and third-party notices`

**Проверка:**
- Проверен JSON в `apps/web/package.json`.
- Изменения запушены в `origin/main`.

## 2026-04-26 — Восстановление prod-запуска Docker на `<APP_SERVER>`

**Задача:** разобраться, почему production stack на сервере `root@<APP_SERVER>`
не запускается через Docker Compose, и довести стек до рабочего состояния.

**Диагностика:**
- `migrate` падал на `gin_trgm_ops`, потому что расширение `pg_trgm` не было
  создано до выполнения первой миграции.
- После падения миграции таблица `schema_migrations` осталась в dirty-состоянии.
- `coturn` уходил в restart loop из-за неподдерживаемого флага `--no-tlsv1_1`.
- `livekit` в `network_mode: host` искал Redis на `127.0.0.1:6379`, но Redis
  был доступен только внутри Docker network.
- `prometheus` не мог писать в bind-volume `/opt/toolkit/data/prometheus`
  из-за владельца директории.
- Prod override портов добавлял приватные bind-порты поверх dev-публикаций.
- `nginx` в prod пытался резолвить `livekit` как Docker-service, хотя LiveKit
  работает в host network.
- `nginx proxy_pass` через переменные некорректно переписывал путь для `/api`
  и `/oauth`.

**Сделано в коде:**
- В первую миграцию добавлены `CREATE EXTENSION IF NOT EXISTS "pgcrypto"` и
  `CREATE EXTENSION IF NOT EXISTS "pg_trgm"`.
- Из compose удалён устаревший флаг coturn `--no-tlsv1_1`.
- В prod-compose Redis опубликован только на `127.0.0.1:${REDIS_PORT}:6379`
  для LiveKit в host network.
- Для prod-портов `minio`, `web`, `prometheus`, `grafana` использован
  `!override`, чтобы не смешивать dev и prod publications.
- Добавлен `ops/nginx/default.prod.conf`, где `/rtc` проксируется в LiveKit
  через `host.docker.internal:7880`.
- В nginx исправлена обработка путей для `/api`, `/oauth`, `/rtc`.
- `/healthz`, `/readyz`, `/version` теперь проксируются в API, а не отдаются
  SPA fallback-ом.

**Сделано на сервере:**
- Выполнен `git pull --ff-only` в `/opt/toolkit`.
- Исправлены права на данные:
  - `/opt/toolkit/data/prometheus` → `65534:65534`
  - `/opt/toolkit/data/grafana` → `472:472`
- Dirty-состояние миграций сброшено, строка `schema_migrations` для версии `0`
  удалена, затем `migrate up` выполнен заново.
- Стек пересобран и поднят через:
  `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build`
- `web` перезапущен после обновления nginx-конфига.

**Коммиты:**
- `b55850f Fix production compose startup issues`
- `cc1d377 Override prod published ports`
- `411d287 Fix prod nginx upstreams`
- `5ceac3b Fix nginx proxy path handling`

**Проверка:**
- `docker compose ps` показывает 17 running-сервисов.
- `http://<APP_SERVER>:18001/healthz` возвращает `{"status":"ok"}`.
- `http://<APP_SERVER>:18001/api/v1/me` возвращает `401`, то есть API доступен
  через nginx и требует авторизацию.
- `http://<APP_SERVER>:18001/rtc/` возвращает `200`, route до LiveKit проходит.
- `http://<APP_SERVER>:9090/-/healthy` возвращает `Prometheus Server is Healthy`.
- Миграции в БД: `version = 7`, `dirty = false`.

**Осталось/наблюдения:**
- Prometheus продолжает скрейпить `/metrics` у API, но backend пока возвращает
  `404`. Это не ломает запуск, но нужно либо добавить endpoint `/metrics`,
  либо временно убрать API target из `ops/prometheus/prometheus.yml`.
- В логах LiveKit есть предупреждения по autodetect external IP и deprecated
  `prometheus_port`; стек работает, но конфиг LiveKit стоит привести к новой
  форме `prometheus.port` отдельной задачей.

## 2026-04-26 — Документация NAT/firewall портов

**Задача:** добавить в README GitHub-репозитория явное описание портов, которые
нужно открыть/пробросить за NAT, чтобы Toolkit работал в production.

**Сделано:**
- В `README.md` добавлен раздел “Порты за NAT / firewall”.
- Описаны публичные DNAT-порты для HTTPS, coturn, LiveKit UDP media и LiveKit TCP
  fallback.
- Отдельно перечислены порты, которые нельзя публиковать в Internet: MinIO,
  Prometheus, Grafana, PostgreSQL, Redis, OpenSearch.
- Добавлены минимальные команды проверки после проброса портов.

**Проверка:**
- Проверен markdown diff.

## 2026-04-26 — Подключение Bitrix24 OAuth для первого клиента

**Задача:** подготовить Toolkit к авторизации через локальное приложение Bitrix24
портала `portal.example.com` и публичный URL `https://toolkit.example.com`.

**Сделано:**
- Проверено, что текущие `/oauth/*` endpoints были stub-обработчиками.
- Добавлен минимальный Bitrix24 OAuth client для authorization-code flow.
- Добавлены handlers `/oauth/login`, `/oauth/callback`, `/oauth/refresh`,
  `/oauth/logout`, `/oauth/install`.
- Callback создаёт или обновляет пользователя Toolkit по `user.current`, создаёт
  HttpOnly refresh-cookie и дальше SPA получает access JWT через `/oauth/refresh`.
- Добавлены env-пробросы `TOOLKIT_BASE_URL`, `TOOLKIT_CORS_ORIGINS`,
  `BITRIX_PORTAL_URL`, `BITRIX_CLIENT_ID`, `BITRIX_CLIENT_SECRET`,
  `BITRIX_APP_TOKEN` в compose.
- `client_secret` не коммитится в репозиторий; секрет должен храниться только
  в `.env` окружения.

**Осталось/наблюдения:**
- После ручного ввода секрета в чат его желательно перевыпустить в Bitrix24.

**Проверка на prod:**
- В `/opt/toolkit/.env` на сервере `<APP_SERVER>` прописаны `TOOLKIT_BASE_URL`,
  `TOOLKIT_CORS_ORIGINS`, `BITRIX_PORTAL_URL`, `BITRIX_CLIENT_ID`,
  `BITRIX_CLIENT_SECRET`.
- Backend пересобран через Docker Compose; `api` и `worker` стартовали.
- `GET /oauth/login?return_to=/phone` возвращает `302` на
  `https://portal.example.com/oauth/authorize/` с callback
  `https://toolkit.example.com/oauth/callback`.
- `POST /oauth/refresh` без cookie возвращает ожидаемый `401`.

## 2026-04-26 — Фикс Bitrix callback на корень приложения

**Задача:** после авторизации Bitrix24 возвращал пользователя на
`https://toolkit.example.com/?code=...&state=...`, а не на
`/oauth/callback`; SPA открывалась без refresh-cookie и снова показывала login.

**Сделано:**
- В nginx-конфиги добавлен exact `location = /`, который при наличии query
  `code` делает `302` на `/oauth/callback?$args`.
- Это сохраняет обычный SPA fallback для `/`, но позволяет обработать callback
  локального приложения Bitrix24, если портал использует путь обработчика как
  корневой URL.

**Проверка:**
- По логам `web` подтверждено, что Bitrix реально возвращал `GET /?code=...`.

## 2026-04-26 — Фикс обмена Bitrix OAuth code на token

**Задача:** после перехода на `/oauth/callback` API возвращал
`bitrix_exchange_failed`; в логах backend была ошибка JSON decode, потому что
запрос token endpoint получал HTML вместо JSON.

**Диагностика:**
- Bitrix24 callback содержит `server_domain=oauth.bitrix24.tech`.
- Toolkit отправлял запрос `/oauth/token/` на URL портала
  `portal.example.com`, а обмен кода нужно делать через OAuth-сервер,
  который Bitrix возвращает в callback.

**Сделано:**
- `server_domain` из callback передаётся в Bitrix client при обмене code на token.
- Bitrix client строит token endpoint от `server_domain`, если он есть, и
  оставляет старый fallback на portal URL.
- Ошибка декодирования ответа Bitrix теперь логирует короткий фрагмент тела
  ответа, чтобы быстрее видеть HTML/JSON-причину.

**Проверка:**
- Prod API пересобран и перезапущен.
- `go test ./...` в Go-контейнере прошёл успешно.
- Для воспроизводимого тестового прогона добавлен отсутствовавший `apps/api/go.sum`
  и indirect-зависимости после `go mod tidy`.
