# Worklog

Журнал технических задач по проекту Toolkit. Сюда заносим существенные изменения,
диагностику прод-инцидентов и важные решения, чтобы история была видна не только
в чате и `git log`.

## 2026-04-27 (ночь) — Settings, OS notifications, WebRTC softphone, cleanup

**Задача:** добиться рабочего MVP-состояния — system settings (доступ к
модулям, SMTP, телефония), OS-уведомления, WebRTC-софтфон через JsSIP,
zero-mock на ключевых страницах.

**Сделано:**

- **TD-фиксы из ревью HEAD~10**:
  - `transcript_recording_active_uniq` partial-index (миграция 000013) +
    `OnEgressEnded` через `SELECT ... FOR UPDATE` с ON CONFLICT по unique —
    идемпотентность при ретрае egress webhook'а; transcribe job ставится
    только на реальный INSERT.
  - `StartRecording` обёрнут в транзакцию с `FOR UPDATE` — защита от
    двойного auto-start при быстром реджойне host'а.
  - `OnEgressEnded` без `return error` после Commit (не провоцируем retry).
  - удалён `ops/livekit/egress.prod.yaml` (заменён на `EGRESS_CONFIG_BODY`
    в compose.prod.yml ещё раньше).

- **«Настройки системы» расширены:**
  - **Пользователи** — реальный `/api/v1/admin/users` (миграция/seed уже
    были; убраны mock-flip role/status кнопки).
  - **Доступ к модулям** — миграция 000014 KV `system_setting`; backend
    `internal/sysset` (ReadRoutes для всех authenticated, WriteRoutes для
    admin); фронт фильтрует NAV для non-admin, при попадании на скрытый
    модуль редирект на первый доступный.
  - **Телефония** разделена на 2 таба: «WebRTC шлюз» (FreePBX WSS +
    extension'ы) и «AMI (мониторинг)» (хост/порт/user/secret + кнопка
    проверки связи; реальная проверка отключена до полноценной интеграции).
  - **SMTP** — реальная персистенция через тот же `system_setting`
    (`smtp_config` ключ); пароль не возвращается в GET; пустой пароль в
    PUT не перезаписывает существующий; тест-эндпоинт возвращает 501.
  - **AI** — без изменений (settings stub).

- **Аналитика → Мониторинг АТС**, перенесена из основного NAV в
  ADM-меню (видна только админу). Заголовок и подзаголовок обновлены.

- **OS-уведомления (Web Notifications API).** AppCtx расширен `osPerm` +
  `requestOSPerm`; `push()` дублирует уведомления в notification center
  ОС когда вкладка не в фокусе. NotificationBell показывает CTA «Включить»
  если permission=default и warning если denied. Иконка — наш logo.

- **WebRTC софтфон** (`apps/web/src/softphone/useSoftphone.ts`).
  Хук-обёртка над `jssip`: state-machine (`not_configured / connecting /
  registered / registration_failed / incoming / outgoing / active / ended`),
  методы `start/stop/dial/answer/hangup/toggleMute/toggleHold`, привязка
  remote-стрима к `<audio autoplay>`. SoftphoneWidget переписан на
  реальный API: dialer работает по живому SIP, входящий звонок показывает
  popup + OS-notification, активный разговор тикает таймер, доступны
  mute/hold/hangup. Если креды не сохранены — встроенная мини-форма
  (WSS URL + extension + пароль), сохраняет в sessionStorage.
  *Не протестировано с реальным FreePBX — нет тестового extension.*

- **Cleanup:**
  - удалены упоминания эпиков (E1.x..E8.x) из всех комментариев и UI-строк;
    «MVP scope» → нейтральная формулировка.
  - StubPage badge «Этап 2» → «В разработке».
  - dead `MaybeStartEgressForParticipant` и его 2 вызова убраны раньше.

- **Документы:**
  - `README.md` обновлён ранее (статусы по эпикам, порт-таблица NAT с UDP
    7882 multiplexed).
  - `DEPLOYMENT.md` — таблица плейсхолдеров.

**Что НЕ сделано (оставлено на следующий заход):**
- E2.4 — Bitrix24 sync пользователей (нужен scheduled job + Bitrix client
  расширение; пока admin-список отражает только тех, кто хоть раз залогинился).
- E6 — реальная интеграция с FreePBX подтверждённая тестовым extension'ом.
- E8 — политики записи, GDPR-запросы, audit-log UI.
- Полная русификация LiveKit-комнаты (нативного i18n у LiveKit нет; нужен
  custom assembly из примитивов TrackToggle / DisconnectButton / ChatToggle).
- TURN — coturn в инфре есть, но `COTURN_EXTERNAL_IP` placeholder + relay
  диапазон не открыт на firewall'е. Поскольку TCP 7881 + UDP 7882 покрывают
  большинство сетей, пока приоритета нет.

**Известные эксплуатационные нюансы:**
- Если правится `ops/livekit/livekit.prod.yaml` или env, требуется ручной
  рестарт `livekit` контейнера (compose не пересобирает image сам).
- Egress prod-конфиг полностью внутри `docker-compose.prod.yml` через
  `EGRESS_CONFIG_BODY`; редактируйте там, а не в `egress.yaml`.

## 2026-04-27 — E5: ВКС end-to-end (комнаты, lobby, запись, скачивание)

**Задача:** дотянуть видеоконференции до уровня MVP — реальные LiveKit-комнаты
вместо демо, гостевой доступ с подтверждением хостом, запись (видео + отдельная
аудио-дорожка), скачивание файлов и автотранскрибация.

**Сделано — backend (`apps/api`):**
- `internal/livekit/client.go` — тонкий Twirp-клиент к LiveKit без `server-sdk-go`:
  `MintJoinToken`, `EndRoom`, `ListParticipants`, `StartRoomCompositeEgress`
  (MP4 grid), `StartRoomCompositeAudioEgress` (OGG audio_only), `StopEgress`.
- `internal/livekit/webhook.go` — `VerifyAndParseWebhook`: проверяет JWT
  + `sha256(body)` подпись от LiveKit и парсит `egress_started/ended/...`.
- `internal/meetings/` — модуль создания/просмотра/завершения встреч, гостевые
  ссылки (`/api/v1/guests/{token}/request` + long-poll status), admit/reject
  pending-гостей хостом, recording start/stop через 2 параллельных egress'а,
  `OnEgressEnded` → создаёт строки `recording` (kind `meeting_composite` для
  MP4 и `meeting_audio` для OGG) + ставит job `transcribe_recording` на
  audio-дорожку, скачивание готовых файлов через `http.ServeContent` с
  Range-поддержкой и Content-Disposition.
- `internal/admin/users.go` — `/api/v1/admin/users` с RBAC = admin: список
  пользователей с email/отделом/должностью/extension/last_login.
- Webhook-handler `/livekit/webhook` (публичный, проверка через HMAC).

**Сделано — миграции:**
- `000009 meeting.guest_link_token` — секрет гостевой ссылки.
- `000010 participant.admit_state` (`pending` / `admitted` / `rejected`) +
  partial-индекс по pending для поллинга хостом.
- `000011 meeting.recording_active`, `recording_started_at`, заготовка
  `participant.current_egress_id` (под будущий per-track).
- `000012` — composite-pivot: `meeting.current_egress_id` (видео MP4) +
  `meeting.current_audio_egress_id` (audio OGG); расширен `recording.kind`
  до `meeting_audio`; добавлена retention policy для `meeting_audio`.

**Сделано — frontend (`apps/web`):**
- `MeetingRoom.tsx` — обёртка над `<LiveKitRoom>` + `<VideoConference>`,
  подключение через `/api/v1/meetings/{id}/join`, кнопки «● Начать запись»/
  «■ Остановить запись» для хоста, панель «Ожидают входа» с Допустить/Отклонить.
- `GuestPage.tsx` — публичный роут `/g/<token>`: форма имени → POST `/request`
  → polling `/status/{rid}` каждые 2с → авто-вход в комнату когда host допустил.
  Stage-machine `form → waiting → admitted/rejected/ended`.
- `Shell.tsx` — VcsPage переписан с реальным API: список встреч, форма
  создания (instant/scheduled), live-таймер, бейдж «● Идёт запись», кнопка
  «Гостевая ссылка» (host копирует в буфер), кнопка «Записи» с dropdown
  для скачивания MP4/OGG, кнопка «Расшифровки» → переход в TranscriptionPage
  с фильтром по meeting_id. UsersPage в Настройках системы — реальный
  `/admin/users`, без mock-flip.
- `App.tsx` — публичный path-router `/g/<token>` обходит auth gate.

**Инфра-правки:**
- `.env`/compose: `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_URL`
  (api → livekit, в prod через `host.docker.internal`), `LIVEKIT_PUBLIC_WS_URL`
  (браузер → wss://...).
- `livekit.prod.yaml`: `rtc.udp_port: 7882` (single-port мультиплекс вместо
  диапазона 50000-60000) + `webhook.urls`.
- `docker-compose.prod.yml`: `extra_hosts: host.docker.internal:host-gateway`
  для api/worker, чтобы достучаться до LiveKit в host-network.

**Известные ограничения:**
- WebRTC-медиа требует DNAT на корпоративном файрволе:
  - TCP 7881 → app-сервер (LiveKit TCP fallback)
  - UDP 7882 → app-сервер (LiveKit RTP мультиплекс)
  - hairpin-NAT включить, иначе клиенты внутри LAN не достучатся до своего
    публичного IP.
- Coturn — добавлен в инфру и DNAT (3478 TCP/UDP), но для полноценного TURN
  нужно открыть relay-диапазон портов (по умолчанию 49152-49999); в большинстве
  сетей direct-path TCP/UDP закрывает кейс без TURN.
- Per-track запись участников отложена (только composite + микшированное
  audio для ASR).
- Полная русификация UI комнаты (LiveKit `<VideoConference>` строки) отложена.

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
