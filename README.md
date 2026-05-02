# Toolkit

**Единый портал коммуникаций для сотрудников.**

Софтфон, видеоконференции, Telegram-мессенджер, Viber user-client runtime и автоматическая транскрибация — в одной вкладке браузера, под одним логином корпоративного Bitrix24, с историей и поиском по всему, что произошло.

---

## Зачем это нужно

Раньше у сотрудника на день была пачка отдельных инструментов: одна вкладка для звонков, другая для встреч, третья для контактов, четвёртая — чтобы найти, кто что обещал по итогам прошлой беседы. Каждый со своим логином, своим интерфейсом, своими правилами доступа.

Toolkit собирает это в один портал так, чтобы:

- **Войти один раз** — через корпоративный Bitrix24 (SSO), без отдельных паролей.
- **Звонить и принимать звонки** прямо из браузера, без установки SIP-клиентов и без привязки к рабочему месту.
- **Подключаться к видеовстречам в один клик** — гостю достаточно ссылки и PIN из письма, ничего ставить не нужно.
- **Писать в Telegram из Toolkit** — пользовательский MTProto-клиент в браузере, без Bot API, с личными чатами и группами.
- **Подключать Viber user-client** — отдельный изолированный worker для сценария, где нужен обычный Viber-клиент, а не Bot/Business API.
- **Не записывать вручную** что говорилось: запись и расшифровка происходят автоматически, по политике, согласованной со службой безопасности.
- **Найти за секунды** любую беседу — по дате, контрагенту, теме разговора (полнотекстовый поиск по транскриптам).

Всё внутри корпоративного контура. Никакие записи, ФИО или номера не уходят во внешние облачные сервисы.

---

## Что внутри

### Для сотрудника

| Модуль | Что делает |
|---|---|
| **Софтфон** | Браузерный WebRTC-клиент к корпоративной АТС на отдельной странице `https://toolkit.softservice.by/softphone`: исходящие, приём входящих с карточкой контакта, журнал звонков по связке user + extension, переводы, сопровождение, объединение в конференцию, статусы присутствия. На главной странице `https://toolkit.softservice.by` отображается только неоновая иконка телефона: зелёная, если пользователь онлайн в телефонии, красная, если софтфон выключен или не зарегистрирован |
| **Видеоконференции** | Разовые и запланированные встречи, гостевой доступ по ссылке с lobby (host подтверждает вход), запись композитная (видео MP4 + отдельная аудио-дорожка OGG) с управлением start/stop из комнаты, автоматическая транскрибация аудио-дорожки и скачивание готовых записей |
| **Мессенджеры** | Telegram как пользовательский MTProto-клиент внутри Toolkit: QR-подключение нескольких аккаунтов, выдача доступа пользователям администратором, личные чаты и группы, поиск по списку чатов, чтение и отправка сообщений, просмотр и отправка фото/видео/аудио/файлов, realtime-обновления через worker + WebSocket, локальный cache с retention 180 дней. Viber вынесен в отдельный user-client worker: Toolkit сохраняет состояние аккаунта, общий cache чатов/сообщений, выдачу доступа и production API-контур; фактическое чтение Viber Desktop зависит от worker-адаптера |
| **Транскрибация** | Расшифровка звонков и встреч (русский язык), разделение по говорящим, синхронизация с записью, ручная правка с историей версий |
| **Поиск** | Полнотекстовый поиск по всем доступным транскриптам с фильтрами по дате, участникам, типу события |

### Для администратора

- Управление пользователями, ролями и внутренними номерами (синхронизация с Bitrix24).
- Настройки Telegram MTProto: API ID/API Hash, ключ шифрования сессий, URL worker, включение синхронизации и retention.
- Выдача доступа к подключенным Telegram/Viber аккаунтам пользователям, по модели назначения как у WebRTC-номеров.
- Статус Viber user-client: worker URL, режим runtime, health/readiness, состояние аккаунта и Desktop gate.
- Политики записи и хранения: глобально, по отделу, по типу вызова — с подтверждением требований 152-ФЗ.
- Запросы субъектов ПДн на удаление — с поиском связанных данных и автоматическим отчётом.
- Audit-log всех чувствительных действий с обоснованием доступа.
- Дашборды и алерты: доступность интеграций, нагрузка SFU, очередь транскрибации.

### Чего нет (намеренно)

- Своего CRM — это остаётся в Bitrix24, Toolkit с ним интегрируется.
- Локальных паролей — только корпоративный SSO.
- Сторонних облачных ASR-сервисов — транскрибация только на собственной модели.
- Английской и других локализаций — пока только русский.

---

## Доступ к данным

Принцип: **сотрудник видит свои разговоры, остальные — по обоснованию и под аудит.**

| Кто | К чему имеет доступ |
|---|---|
| Сотрудник | Свои звонки, встречи, транскрипты — без обоснования |
| Прямой руководитель | Записи прямых подчинённых — с письменным обоснованием, уведомлением сотрудника и записью в audit-log |
| Администратор | Все записи — с обоснованием и аудитом; политики и регламенты |
| Внешний участник | Не имеет аккаунта; видит только встречу/звонок, в которых участвовал |

Записи хранятся со сроком, заданным администратором; досрочное удаление возможно только по запросу 152-ФЗ или с retention-hold от администратора.

---

## Технологический стек

### Backend (`apps/api`)

| Компонент | Что использует |
|---|---|
| Язык и runtime | **Go 1.23**, single-binary с режимами `api`, `worker`, `migrate` |
| HTTP-роутер | `go-chi/chi v5` + middleware (RequestID, RealIP, Recoverer) |
| WebSocket | `coder/websocket` — per-user подписки, ping каждые 30с |
| База данных | `jackc/pgx/v5` (драйвер + pool) |
| Миграции | `golang-migrate/migrate v4` (идемпотентные SQL, источник `file://`) |
| JWT | `golang-jwt/jwt/v5`, HS256, access-токен 15 мин |
| Сессии | refresh-токен `crypto/rand` 32 байта, хранится как `sha256` хеш в БД, sliding TTL 30 дней |
| OAuth state | HMAC-SHA256 с встроенным TTL (10 мин), без БД |
| Очередь джобов | Postgres-таблица `job` + `FOR UPDATE SKIP LOCKED`, экспоненциальный backoff, dead-letter после `max_attempts` |
| Rate limit | `go-chi/httprate` (по IP и по user_id) |
| CORS | `go-chi/cors` |
| Логи | `log/slog` (JSON), обогащение `request_id` / `user_id` / `role` / `session_id` |
| API-контракт | OpenAPI 3.1 (spec в `apps/api/api/openapi.yaml`) |
| Тесты | `testing` стандартной библиотеки |

### Frontend (`apps/web`)

| Компонент | Что использует |
|---|---|
| Сборщик | **Vite 5** с TypeScript-плагином React |
| Язык | **TypeScript 5.6** (strict) |
| UI-фреймворк | **React 18** |
| Роутинг | `react-router-dom v6` |
| Server state | `@tanstack/react-query v5` |
| Иконки | `lucide-react` |
| Локализация | `i18next` + `react-i18next` (RU) |
| Стили | inline-styles на единых дизайн-токенах + общий `globals.css` |
| API-клиент | нативный `fetch`, codegen типов из OpenAPI через `openapi-typescript` |
| Авторизация | контекст с восстановлением через `/oauth/refresh`, JWT в HTTP `Authorization: Bearer` |
| WebSocket | нативный `WebSocket` с экспоненциальным reconnect (1s → 30s) и подпиской по типу события |
| E2E-тесты | **Playwright** (Chromium / Firefox / WebKit) |
| Unit-тесты | **Vitest** |

#### Маршрут софтфона

Полный интерфейс телефона открывается отдельной страницей:

```text
https://toolkit.softservice.by/softphone
```

На основной странице портала `https://toolkit.softservice.by` не должно быть
встроенного dialer-виджета или всплывающего телефона. Там остаётся только
иконка телефона в навигации/шапке:

- **зелёное неоновое свечение** — пользователь онлайн и зарегистрирован в телефонии;
- **красное неоновое свечение** — софтфон выключен, не зарегистрирован или недоступен.

Нажатие на иконку открывает `/softphone`.

### Инфраструктура

| Сервис | Образ | Назначение |
|---|---|---|
| **PostgreSQL 16** | `postgres:16-alpine` | Основная БД (роли `toolkit_app`, `toolkit_audit_writer`, `toolkit_audit_reader`) |
| **MinIO** | `minio/minio:latest` | S3-совместимое хранилище (записи, отчёты, бэкапы) |
| **OpenSearch 2.13** | `opensearchproject/opensearch:2.13.0` | Полнотекстовый поиск по транскриптам |
| **Redis 7** | `redis:7-alpine` | Координация LiveKit Egress (только; приложение использует Postgres) |
| **LiveKit Server** | `livekit/livekit-server:latest` | WebRTC SFU для видеоконференций |
| **LiveKit Egress** | `livekit/egress:latest` | Запись встреч (composite видео+аудио + отдельная аудио-дорожка для ASR) |
| **coturn** | `coturn/coturn:latest` | STUN/TURN для прохождения NAT в WebRTC |
| **Nginx 1.27** | `nginx:1.27-alpine` | Внутренний reverse-proxy: SPA-статика + `/api`, `/oauth`, `/rtc` |
| **Telegram Worker** | `apps/telegram-worker` (Node.js 20 + GramJS) | Постоянная MTProto-сессия, QR-login, синхронизация личных чатов и групп, отправка сообщений, push новых сообщений в API |
| **Viber Worker** | `apps/viber-worker` (Node.js + Playwright / Desktop runtime hook) | Изолированный worker для Viber user-client. API/DB-контур production-ready; browser target остаётся диагностическим, реальные чаты требуют Desktop runtime/adapter |

### Мониторинг

| Сервис | Образ | Что собирает |
|---|---|---|
| **Prometheus** | `prom/prometheus:latest` | Метрики API, LiveKit, Postgres, host |
| **Grafana 11.1** | `grafana/grafana:11.1.0` | 4 дашборда (System / PostgreSQL / LiveKit / API) + 9 unified-alerting правил с SMTP-доставкой |
| **Loki 3.0** | `grafana/loki:3.0.0` | Хранение логов |
| **Promtail 3.0** | `grafana/promtail:3.0.0` | Сбор логов всех контейнеров через Docker socket |
| **node-exporter** | `prom/node-exporter:v1.8.2` | CPU / RAM / диск / сеть хоста |
| **postgres-exporter** | `prometheuscommunity/postgres-exporter:v0.15.0` | Метрики PostgreSQL |

### Резервное копирование

| Контейнер | Что делает |
|---|---|
| **postgres-backup** | Собственный образ: `pg_dump` каждые 24ч → MinIO bucket `backups` с retention 30 дней |

### Внешние интеграции

| Система | Протокол | Зона ответственности Toolkit |
|---|---|---|
| **Bitrix24** | OAuth 2.0 + REST API (локальное приложение, скопы `user`, `department`, `crm`) | Авторизация, профили, резолв номеров |
| **FreePBX** | WSS (сигнализация) + SRTP (медиа) + REST (CDR/recordings) | WebRTC-клиент, импорт записей и истории |
| **Telegram** | MTProto через GramJS user-client | QR-подключение аккаунта, личные чаты и группы, cache сообщений, realtime updates; не используется Bot API |
| **Viber** | User-client runtime | Неофициальный изолированный адаптер. Toolkit хранит аккаунт и cache в общих messenger-таблицах; browser mode используется для диагностики, production-чаты требуют Desktop runtime |
| **GigaAM ASR** | REST polling (`POST /stt/transcribe` → `GET /stt/result/{task_id}`) | Транскрибация записей звонков и встреч (русский) |
| **SMTP** | STARTTLS | Уведомления, приглашения, алерты |

#### Telegram-мессенджер

Telegram работает как пользовательский клиент, а не как бот. Администратор задаёт параметры в `Настройки системы → Мессенджеры`: `api_id`, `api_hash`, ключ шифрования MTProto-сессий, URL worker и retention cache. Пользователь подключает аккаунт по QR-коду, после чего Toolkit синхронизирует личные чаты и группы, хранит последние сообщения в `messenger_message` и показывает их в интерфейсе `/messengers`. Один владелец может подключить несколько аккаунтов, а администратор выдаёт доступ к конкретному аккаунту другим пользователям в блоке `Аккаунты и доступ`.

Поток realtime-обновлений:

```text
Telegram MTProto updates
  -> telegram-worker
  -> POST /api/v1/messenger-internal/telegram/updates
  -> messenger_message
  -> WebSocket event messenger.message.created
  -> React Query обновляет список чатов и открытую переписку
```

Для запуска нужны переменные окружения или значения из системных настроек:

```env
TELEGRAM_API_ID=0
TELEGRAM_API_HASH=
TELEGRAM_SESSION_ENCRYPTION_KEY=generate-a-32-byte-base64-key
TELEGRAM_SYNC_ENABLED=true
TELEGRAM_RETENTION_DAYS=180
TELEGRAM_WORKER_URL=http://telegram-worker:8090
```

### Развёртывание

- **Оркестрация:** `docker compose` (v2). Без Kubernetes — оправдано масштабом MVP.
- **Базовая ОС:** Debian 13 / Ubuntu 22.04 LTS на app-сервере в корпоративной сети.
- **TLS-терминация:** на внешнем nginx-proxy с Let's Encrypt; внутренний канал — приватная сеть.
- **HA:** не входит в MVP (целевой SLA 99,0%, RPO ≤ 24ч / RTO ≤ 2ч).

### Порты за NAT / firewall

Production-схема предполагает внешний reverse-proxy для HTTPS и отдельный app-сервер
с Docker Compose. Для WebRTC-медиа одних `443/TCP` недостаточно: браузерам нужны UDP
порты LiveKit и TURN.

| Откуда | Порт / протокол | Куда DNAT / разрешить | Назначение |
|---|---:|---|---|
| Internet | `443/TCP` | reverse-proxy `:443` | HTTPS для SPA, REST API, OAuth и WebSocket-сигналинга `/rtc` |
| reverse-proxy | `APP_BIND_PORT/TCP` (`18001` по умолчанию) | app-сервер `APP_BIND_ADDRESS:18001` | Внутренний HTTP до контейнера `web`; не публиковать напрямую в Internet |
| Internet | `3478/UDP` | app-сервер `:3478` | STUN/TURN через coturn |
| Internet | `3478/TCP` | app-сервер `:3478` | TURN TCP fallback |
| Internet | `7881/TCP` | app-сервер `:7881` | LiveKit TCP ICE fallback (работает в сетях, где UDP режется) |
| Internet | `7882/UDP` | app-сервер `:7882` | LiveKit WebRTC media — single port (`rtc.udp_port`, мультиплекс всех сессий) |
| Internet | `49152-49999/UDP` | app-сервер `:49152-49999` | UDP relay-порты coturn (`--min-port/--max-port`); диапазон можно сократить — см. конфиг coturn |
| admin/VPN | `22/TCP` | app-сервер `:22` | SSH-администрирование, только по allowlist |

Не открывать в Internet:

| Порт | Назначение | Доступ |
|---:|---|---|
| `9000/TCP`, `9001/TCP` | MinIO API/Console | Только приватная сеть/VPN |
| `9090/TCP` | Prometheus | Только приватная сеть/VPN |
| `3001/TCP` | Grafana | Только приватная сеть/VPN |
| `5432/TCP` | PostgreSQL | Не публикуется наружу |
| `6379/TCP` | Redis | Только `127.0.0.1` на app-сервере для LiveKit |
| `9200/TCP` | OpenSearch | Не публикуется наружу |

Минимальная проверка после проброса:

```bash
curl -I https://<TOOLKIT_DOMAIN>
curl -fsS http://<APP_BIND_ADDRESS>:18001/healthz
curl -fsS http://<APP_BIND_ADDRESS>:9090/-/healthy
```

Для внешней ВКС-проверки дополнительно убедитесь, что TCP `7881`, UDP `7882`
и (если используется TURN) UDP `49152-49999` не блокируются граничным
firewall после DNAT.

---

## Документы

- **Техническое задание MVP** — функциональные и нефункциональные требования.
- **Архитектурный документ** — компоненты, потоки данных, модель данных, безопасность.
- **Декомпозиция работ** — план работ по эпикам, сроки, риски.
- **Roadmap** — версии после MVP (расширение мессенджеров, контакты, хелпдэск, LLM-суммаризация, realtime-транскрибация и далее).

Документы для команд эксплуатации (deployment runbook, operating procedures) — поставляются вместе с релизом, не публикуются здесь.

---

## Состояние

Версия MVP в активной разработке. Production-релиз — по итогам приёмки заказчика.

### Кратко

**Готово и развёрнуто на проде:**

- ✅ **Авторизация** — OAuth Bitrix24, JWT (HS256, 15 мин) + refresh-сессии, RBAC (admin / user / контекстная manager).
- ✅ **Синхронизация пользователей с Bitrix24** — manual через UI, фильтр `active+employee`, исключение экстранета, soft-deactivate отсутствующих, реактивация вернувшихся, OAuth refresh через `oauth.bitrix.info`.
- ✅ **Видеоконференции** — LiveKit-комнаты, гостевые ссылки с lobby (admit/reject), composite-запись (видео MP4 + audio OGG), скачивание файлов, авто-транскрибация audio-дорожки, custom RU-UI комнаты, guard от прерванных egress'ов.
- ✅ **Приглашение участников встречи** — multi-select сотрудников из синхронизированной таблицы `user` (поиск по имени/email/отделу) + email-приглашения внешним адресатам со ссылкой на guest-вход (HTML-письма через SMTP, асинхронная отправка через job-очередь).
- ✅ **Email-пайплайн** — SMTP-сендер с поддержкой SSL/STARTTLS/none, конфиг из Settings → SMTP подгружается на лету. Используется для приглашений на встречи; готов к подключению других уведомлений.
- ✅ **Транскрибация** — GigaAM ASR через polling, viewer с диалогом по каналам, аналитика, экспорт TXT, ручная загрузка аудио.
- ✅ **Софтфон (WebRTC)** — JsSIP-клиент к FreePBX (WSS), отдельная страница `/softphone`, исходящие/входящие, журнал звонков, mute/hold/dial-pad, перевод, сопровождение и join, креды подтягиваются с бэкенда (extension, привязанный админом к user'у). На главной странице остаётся только неоновая статус-иконка телефона.
- ✅ **Telegram-мессенджер** — MTProto user-client внутри Toolkit: настройки админа, QR-подключение нескольких аккаунтов, админская выдача доступа пользователям, личные чаты и группы, поиск по чатам, чтение/отправка сообщений, просмотр и отправка вложений (фото, видео, аудио, документы), realtime updates через `telegram-worker` → API → WebSocket, cache retention 180 дней.
- ✅ **Настройки системы** — разделы с реальной персистенцией: Пользователи (роли/блокировка/Bitrix-синк), Доступ к модулям, Телефония (WebRTC + AMI), SMTP, Мессенджеры. Доступ к модулям фильтрует NAV для не-админа.
- ✅ **OS-уведомления** — Web Notifications API (входящие звонки, события встреч), CTA на подключение в NotificationBell.
- ✅ **Каркас** — Vite + React 18 + TS strict, chi-роутер, Postgres (pgx/v5), очередь джобов на Postgres+SKIP LOCKED, WebSocket-hub, structured slog.
- ✅ **Инфраструктура** — docker-compose стек (Postgres / MinIO / OpenSearch / LiveKit-server + Egress / coturn / Redis / Nginx + Prometheus / Grafana / Loki / Promtail / postgres-backup).

**Не готово (известные пробелы MVP):**

- ❌ **Bitrix sync — фоновое расписание.** Сейчас только ручной запуск из UI. Cron/scheduler в `job` не подключён.
- ❌ **Реальное тестирование софтфона с боевым FreePBX-extension'ом** — код написан, но проверка end-to-end не проводилась (нужен тестовый номер от АТС).
- ❌ **Telegram расширенный auth и CRM-привязка** — вход по номеру/коду/2FA, каналы, секретные чаты, статусы доставки/прочтения и привязка Telegram-чата к CRM-контакту/сделке вынесены в следующий этап.
- ❌ **Политики записи и retention UI** — backend ENUM в схеме есть, админский UI для редактирования нет.
- ❌ **GDPR-запросы UI** — в БД есть таблица, в UI нет страницы поиска/закрытия запросов 152-ФЗ.
- ❌ **Audit-log UI** — данные в БД пишутся, страницы просмотра нет.
- ❌ **SMTP test-send** — кнопка «Проверить отправку» в Настройках → SMTP пока возвращает 501. Реальные приглашения на встречи отправляются.
- ❌ **AMI (Asterisk Manager Interface) для модуля «Мониторинг АТС»** — UI готов, реальная интеграция не сделана.
- ❌ **CI/CD и отдельный staging** — отложены.

| Эпик | Что внутри | Статус |
|---|---|---|
| **E0** Инфраструктура | docker-compose стек, Postgres / MinIO / OpenSearch / LiveKit / coturn / Prometheus / Grafana / Loki / бэкапы | Готово (CI и отдельный staging — отложены) |
| **E1** Авторизация | OAuth Bitrix24, JWT-сессии (HS256, 15 мин) + refresh, RBAC | Готово |
| **E2.1** Схема БД | 18 миграций (user / contact_cache / call / meeting / participant / recording / transcript / gdpr / softphone / system_setting / meeting_invitation / messenger_telegram) | Готово |
| **E2.4** Sync пользователей | Bitrix `user.get` через OAuth admin-сессии (refresh через `oauth.bitrix.info`), фильтр `active+employee`, исключение экстранета, реактивация вернувшихся, soft-deactivate отсутствующих. Запуск из UI «Настройки → Пользователи → Синхронизировать с Bitrix24» | Готово (фоновый scheduler — отложен) |
| **E3** Backend-каркас | chi-роутер, RequireAuth/RequireRole, очередь джобов на Postgres+SKIP LOCKED, WebSocket-hub, structured slog | Готово |
| **E4** Фронт-каркас | Vite + React + TS, авторизация, единый Shell, тёмные/светлые токены, i18n RU, OS-уведомления через Web Notifications API | Готово |
| **E5** Видеоконференции | LiveKit-комнаты, гостевые ссылки, lobby с admit/reject, composite-запись (видео MP4 + audio OGG), скачивание файлов, авто-транскрибация audio-дорожки, custom RU-UI комнаты, guard от ABORTED egress, **multi-select сотрудников и email-приглашения внешним адресатам** | Готово |
| **E6** Софтфон | Браузерный JsSIP-клиент к FreePBX (WSS) на отдельном маршруте `/softphone`: input/output, mute/hold/dial, transfer, attended transfer, join, журнал звонков. Креды подтягиваются с бэкенда (`/system-settings/phone/me`) — extension, привязанный админом к user'у. На главной странице `toolkit.softservice.by` отображается только неоновая статус-иконка телефона: зелёная online, красная выключен/не зарегистрирован | Готово (требуется боевое тестирование с реальным extension) |
| **E7** Транскрибация | GigaAM ASR через polling, viewer с диалогом по каналам, аналитика, экспорт TXT, ручная загрузка файлов | Готово |
| **E8** Админ | Разделы «Настройки системы»: Пользователи (роли/блокировка/Bitrix-синк), Доступ к модулям, Телефония (WebRTC + AMI), SMTP, Мессенджеры. SMTP-сендер реально отправляет email-приглашения. Политики записи и GDPR-запросы | Частично (settings + sync + email-pipeline + messenger settings — да; политики/GDPR/audit-log UI — запланированы) |
| **E9** Мессенджеры | Telegram user-client: GramJS worker, QR-login, хранение зашифрованной MTProto-сессии, sync личных чатов и групп, cache 500 сообщений на чат с retention 180 дней, отправка текста и вложений, просмотр/скачивание фото/видео/аудио/документов, WebSocket realtime, Telegram-like UI и поиск по чатам. Viber: отдельный worker, provider `viber` в БД, account/status/cache API, Desktop runtime gate | Telegram готово для MVP; Viber production-контур готов, Desktop-adapter в работе |

## Лицензия

Код Toolkit распространяется под лицензией Apache License 2.0. См. [LICENSE](LICENSE).

Сторонние библиотеки, контейнерные образы и внешние системы остаются под своими лицензиями и условиями использования. Краткий список ключевых компонентов приведён в [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
