# Worklog

Журнал технических задач по проекту Toolkit. Сюда заносим существенные изменения,
диагностику прод-инцидентов и важные решения, чтобы история была видна не только
в чате и `git log`.

## 2026-04-27 (день) — Email-приглашения на встречи + multi-select участников

**Контекст:** после Bitrix-синка (предыдущая итерация) в БД появилось 141
активный сотрудник, нужно дать возможность приглашать их на встречи + слать
email со ссылкой на guest-вход внешним адресатам.

**Сделано:**

- **Миграция 000015 `meeting_invitation`** — id, meeting_id (FK CASCADE), email,
  invited_by, status (pending/sent/failed), sent_at, last_error, attempts,
  created_at. UNIQUE по `(meeting_id, LOWER(email))` чтобы повторное приглашение
  не плодило дубль.

- **`internal/mailer`** — универсальный SMTP-сендер. Конфиг тянется на лету из
  `system_setting/smtp_config` (тот же ключ, что и админская страница SMTP).
  Поддержка SSL implicit (порт 465), STARTTLS (587/25) и plain. Заголовки
  Subject и From-name MIME-Q-кодируются для UTF-8.

- **`meetings.Service.Create` + `CreateInput.InviteeEmails`** — dedup'нутые
  адреса (нормализация + валидация на @) вставляются в `meeting_invitation`
  через ON CONFLICT DO UPDATE (для возврата id), на каждую — job
  `send_meeting_invitation` в очередь.

- **`meetings.InvitationWorker.Handle`** — отправляет HTML-письмо со ссылкой
  на гостевой вход (`/g/<guest_link_token>`); если token ещё не сгенерирован,
  генерирует и сохраняет в `meeting.guest_link_token`. Permanent-failure
  (meeting удалён) → возвращаем nil чтобы не зацикливать ретраи; transient →
  error → queue ретраит с экспоненциальным backoff. На каждый прогон
  обновляются `status / sent_at / last_error / attempts`.

- **`meetings.Service.SearchUsers` + `GET /api/v1/users/search?q=`** — поиск
  активных сотрудников по `name/email/department/position` через ILIKE.
  Доступен любому authenticated user'у (НЕ admin only) — возвращает только
  публичные поля (без extension/is_admin/status). Лимит 20 (max 50).

- **Frontend `useUserSearch(query)`** — debounced на 200ms.

- **Frontend `InviteParticipantsField`** в диалоге создания встречи:
  searchable dropdown сотрудников (исключает себя и уже выбранных) с avatar
  + ФИО + отдел; chip'ы выбранных с возможностью удалить; раздел «Внешние
  email'ы» с chip'ами через Enter/comma и backspace для удаления последнего.
  Лёгкая валидация email-regex на клиенте. На submit передаём
  `participant_ids` (UUIDs) + `invitee_emails` (строки).

- **Регистрация invitation handler в `worker.go`.** Worker теперь регистрирует
  два kind'а: `transcribe_recording` и `send_meeting_invitation`.

**Известные ограничения:**
- SMTP test-кнопка («Проверить отправку») в Settings → SMTP пока возвращает
  501 — реальный test-send не подключён, хотя пайплайн уже готов и работает
  для приглашений.
- Нет UI просмотра/повторной отправки приглашений на странице встречи. Если
  email failed — придётся либо закидывать вручную в БД (`UPDATE meeting_invitation
  SET status='pending'`), либо пересоздавать встречу.
- Внутренние сотрудники (приглашённые через multi-select) email НЕ получают —
  встреча просто появляется у них в списке. Если нужно дублирующее уведомление
  на корпоративный email — отдельная задача (можно поверх той же job-pipeline).

**Коммит:** `7709fee Meetings: приглашение участников по email + поиск по таблице user`

## 2026-04-27 (утро) — Phone user-picker, softphone-from-backend, recording guard, Bitrix sync

**Контекст:** обнаружено, что (1) Settings → Телефония → Внутренние номера сохраняли
ext+pwd, но не давали привязать к user'у; (2) после ввода extension'а в админке
SoftphoneWidget продолжал требовать ручной ввод credentials; (3) попытка скачать
запись отдавала 500 для встреч, где egress был прерван («Start signal not received»);
(4) E2.4 — Bitrix24 user sync — оставался в списке отложенных.

**Сделано:**

- **Phone settings: dropdown пользователей.** В строке каждого extension'а появился
  `<select>` со списком пользователей из `useAdminUsers()`. Один user — один номер
  (занятые id'шники прячутся в чужих селектах). Если ранее привязанный пользователь
  удалён/заблокирован, отображается заглушка `(пользователь #abcdef12 недоступен)`,
  чтобы не терять выбор. Backend в `sysset.PhoneExtension` уже хранил `assigned_to`,
  правки только в UI (commit `d0cae3f`).

- **Softphone-from-backend.** Новый эндпоинт `GET /api/v1/system-settings/phone/me`
  (auth, не admin) ищет в `phone_config.extensions` запись с `assigned_to = subject.UserID`
  и возвращает `{wss_url, extension, password}`. Если не назначен — 404 not_assigned.
  `useMyPhoneCredentials()` хук с retry=false и обработкой 404 как «нормальное пусто».
  `SoftphoneWidget` на mount тянет креды → `phone.start()` автоматически. Sessionstorage
  остаётся как dev-override. `useUpdatePhoneConfig` invalidate'ит `["my-phone-credentials"]`,
  чтобы UA переподнимался без перезагрузки страницы (commit `6274ba0`).

- **Recording guard для прерванных egress'ов.** `OnEgressEnded` теперь проверяет
  `info.Status == "EGRESS_COMPLETE"` и `fr.SizeBytes() > 0`. Раньше LiveKit для
  `EGRESS_ABORTED` присылал webhook с заполненным template-filename, мы создавали
  recording-row, UI показывал «Скачать», запрос падал в `http.ServeContent` с 500
  (NoSuchKey в MinIO). Теперь pointer'ы зачищаем, но row не создаём. Сценарий из
  прода: пользователь нажал «Стоп» через 8с после «Старта», Chrome внутри egress
  не успел поднять stream → ABORTED. Также защищает от FAILED и LIMIT_REACHED.
  Существующие orphan-строки (recording rows без объектов в S3 + связанный failed
  transcript + dead-letter job) почищены вручную через psql (commit `8e0f9e6`).

- **Bitrix24 user sync (E2.4).** Реализована синхронизация:
  - `bitrix.Client.RefreshAccessToken(refreshToken, serverDomain)` — обмен на пару
    новых токенов. Хардкодим `serverDomain="oauth.bitrix.info"` — единый OAuth-прокси
    Bitrix24 и для cloud, и для коробочных установок с локальными приложениями.
    Сам портал `/oauth/token/` отдаёт login HTML вместо JSON.
  - `bitrix.Client.ListEmployees(accessToken, start)` — `user.get` с
    `FILTER USER_TYPE=employee + ACTIVE=Y + ADMIN_MODE=true`, постранично по 50.
  - `usersync.Run(ctx, db, client)` — берёт самую свежую активную admin-сессию с
    непустым `bitrix_refresh_token_encrypted` (хранится base64 в session table),
    refresh'ит → access_token + новый refresh, сохраняет refresh обратно в ту же
    сессию (Bitrix-овские refresh одноразовые). Затем итерирует страницы, UPSERT'ит
    в `"user"` через CTE `prev / upd` (отличает inserted / reactivated / updated по
    предыдущему статусу). Отсутствующих в выгрузке помечает
    `status='deactivated_in_bitrix', deleted_in_bx24=true` — записи не удаляются,
    история мероприятий/звонков сохраняется. Если в Bitrix у пользователя пусто
    `EMAIL` — генерируется синтетический `bx-{id}@no-email.local`, чтобы пройти
    UNIQUE-индекс; войти под такой записью нельзя, но в селекторе она видна.
  - Endpoint `POST /api/v1/admin/users/sync/bitrix` (admin only) → JSON
    `{fetched, added, updated, reactivated, deactivated, skipped, errors[]}`.
  - Frontend: хук `useSyncBitrixUsers`, кнопка «Синхронизировать с Bitrix24» в
    Настройки → Пользователи (рядом с поиском). По завершении alert со статистикой.
  - Если ни одной активной admin-сессии с bitrix-токеном нет — endpoint возвращает
    `502 sync_failed: нет активной admin-сессии с bitrix-токеном; войдите как
    админ через Bitrix24 и повторите` (commits `1453755` → `c0d7956` → `8ba833d`).

- **Документация:** обновлены статусы в `README.md` (E2.4 → ✅, E5 без оговорок про
  русификацию, E6 → ✅ с caveat про боевой extension, E8 расширен), добавлен
  явный блок «Готово / Не готово».

**Что НЕ сделано (оставлено на следующий заход):**

- Фоновое расписание Bitrix-sync (cron-job каждые N минут поверх существующего
  `internal/queue`). Пока только manual из UI.
- Реальное end-to-end тестирование софтфона с боевым FreePBX-extension'ом.
- Email-пайплайн: SMTP-настройки сохраняются, но реальная отправка (приглашения
  на встречу, алерты) пока не подключена. Тест-кнопка возвращает 501.
- Приглашение участников встречи по email + поиск (мульти-селектор поверх
  свежесинхронизированной таблицы `user`).
- Политики записи / GDPR / audit-log — отдельные страницы в Настройках.

**Прод-инциденты по ходу:**

- 500 на `/recordings/{id}/download` для встречи `mtg-dfa8dc07`. Диагноз: 2 строки
  в `recording` с `size_bytes=0`, файлов в MinIO нет, вызов `http.ServeContent` падал
  на Seek с NoSuchKey — а `ServeContent` пишет свой собственный 500 plain-text,
  поэтому в логах был только `bytes=18 status=500` без подробностей. Найдено через
  логи egress: `EGRESS_ABORTED, "Start signal not received"`. Зафикшено + почищено.
- HTML-ответ от Bitrix при первом запуске sync. Диагноз: вызов
  `https://portal.softservice.by/oauth/token/` возвращает login-page HTML вместо JSON
  (для самохостед-Bitrix этот endpoint просто не реализован; OAuth refresh идёт
  через `oauth.bitrix.info`). Зафикшено хардкодом server-domain в `usersync`.

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

## 2026-04-26 — Восстановление prod-запуска Docker (операционные нюансы)

Историческая запись с эксплуатационными деталями, которые могут потребоваться
при поднятии стека на новой машине.

**Что было сломано / как починили:**
- `migrate` падал на `gin_trgm_ops` — добавили `CREATE EXTENSION pg_trgm` и
  `pgcrypto` в первую миграцию.
- `coturn` в restart loop из-за неподдерживаемого флага `--no-tlsv1_1` — убрали.
- `livekit` в `network_mode: host` искал Redis на `127.0.0.1:6379`, а тот был
  только внутри Docker network — в prod-compose Redis опубликован на
  `127.0.0.1:${REDIS_PORT}:6379`.
- `prometheus`/`grafana` не могли писать в bind-volume — поправили владельца:
  - `/opt/toolkit/data/prometheus` → `65534:65534`
  - `/opt/toolkit/data/grafana` → `472:472`
- Prod-override портов смешивался с dev-публикациями — для `minio`/`web`/
  `prometheus`/`grafana` использован `!override`.
- nginx в prod пытался резолвить `livekit` как Docker-service — добавлен
  `ops/nginx/default.prod.conf`, где `/rtc` проксируется через
  `host.docker.internal:7880`.
- nginx некорректно переписывал путь для `/api`, `/oauth` — исправлено.
- `/healthz`, `/readyz`, `/version` теперь проксируются в API, а не отдаются
  SPA fallback-ом.

**Команды для прод-релиза:**
```bash
cd /opt/toolkit && git pull --ff-only
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

**Известная мелочь:** Prometheus скрейпит `/metrics` у API, тот возвращает 404
(не блокирует запуск). Endpoint планируется добавить, либо убрать target из
`ops/prometheus/prometheus.yml`.
