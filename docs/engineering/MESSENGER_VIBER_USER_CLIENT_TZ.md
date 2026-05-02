# ТЗ: Viber в Toolkit через неофициальный user-client

## 1. Цель

Добавить в раздел `Мессенджеры` поддержку Viber так, чтобы оператор мог работать с Viber-перепиской внутри Toolkit примерно как с Telegram:

- подключить Viber-аккаунт;
- видеть список личных чатов и групп;
- открывать переписку;
- получать новые сообщения без ручного обновления;
- отправлять текст, изображения, видео, аудио и файлы;
- хранить локальный cache сообщений и вложений с retention 180 дней.

Важно: Viber не предоставляет официальный MTProto-подобный user-client API. Официальная интеграция Viber рассчитана на Bot/Business API. Поэтому этот этап является R&D/experimental и не должен ломать основной Telegram-мессенджер.

## 2. Почему Не Bot API

Требование продукта: пользователь хочет работать с Viber как с обычным клиентом, а не от имени бота или бизнес-аккаунта.

Официальный Bot API подходит для корпоративного канала, но имеет ограничения:

- переписка идёт от имени bot/business account;
- пользователь должен взаимодействовать с ботом;
- это не личный Viber-аккаунт сотрудника;
- логика подписки, webhook и коммерческие условия отличаются от обычного клиента.

Для user-client сценария нужен отдельный экспериментальный адаптер, который автоматизирует обычный Viber Desktop/Web-клиент или совместимый runtime.

## 3. Главный Риск

Неофициальный user-client может:

- перестать работать после обновления Viber;
- нарушать условия использования Viber;
- приводить к блокировке аккаунта;
- требовать интерактивной авторизации через QR/телефон;
- быть нестабильным в headless-режиме;
- иметь ограничения по отправке/скачиванию медиа;
- плохо масштабироваться на много аккаунтов.

Решение о продакшен-включении принимается только после PoC и юридической оценки.

## 4. Рекомендуемый Стек

### Backend Toolkit

- Go 1.23;
- существующий `apps/api/internal/messenger`;
- Postgres как cache сообщений, чатов, вложений и состояния аккаунта;
- существующий WebSocket hub для realtime-событий;
- существующий auth/RBAC Toolkit.

### Viber User-Client Worker

Рекомендуемый вариант для PoC:

- Node.js 20;
- Playwright Chromium persistent context;
- Xvfb/headless-shell только если Viber Web/Desktop корректно работает без GUI;
- отдельный Docker service `viber-worker`;
- volume для профилей Viber-сессий;
- внутренний REST API между `api` и `viber-worker`;
- callback из worker в API для новых сообщений.

Альтернативный вариант, если web-клиент Viber не даёт нужной стабильности:

- Linux container с Viber Desktop под Wine/Xvfb;
- управление через accessibility/DOM/screenshot automation;
- этот вариант считать последним, потому что он самый хрупкий.

Не использовать в основном production backend reverse-engineering код напрямую. Всё неофициальное должно жить в изолированном worker.

### Frontend

- React 18;
- TypeScript;
- TanStack Query;
- общий UI `MessengerPage` должен стать provider-aware:
  - `telegram`;
  - `viber`;
- общие компоненты:
  - `ChatList`;
  - `MessageThread`;
  - `AttachmentView`;
  - `Composer`;
  - `ProviderConnectView`.

## 5. Архитектура

```text
Browser Toolkit
  -> /api/v1/messenger/viber/*
  -> Toolkit API
  -> viber-worker internal REST
  -> Viber Web/Desktop session
  -> Viber network

Viber Web/Desktop updates
  -> viber-worker watcher
  -> POST /api/v1/messenger-internal/viber/updates
  -> messenger_message / messenger_attachment
  -> WebSocket event messenger.message.created
  -> React обновляет чат
```

## 6. Изоляция

`viber-worker` должен быть отделён от `api`:

- отдельный контейнер;
- отдельный Docker volume для browser profiles;
- без доступа к JWT secret;
- без доступа к Bitrix tokens;
- доступ к API только через internal callback secret;
- rate limit на команды;
- подробные health/status endpoints;
- возможность отключить worker без остановки Telegram.

## 7. Модель Данных

Расширить существующие таблицы мессенджера.

### `messenger_account`

Разрешить provider:

```sql
provider IN ('telegram', 'viber')
```

Для Viber:

- `provider_user_id` — Viber user/phone id, если удаётся извлечь;
- `display_name` — имя аккаунта;
- `phone_masked` — маскированный телефон;
- `status`:
  - `connecting`;
  - `connected`;
  - `error`;
  - `revoked`.

### `messenger_viber_session`

Новая таблица:

```sql
CREATE TABLE messenger_viber_session (
    account_id          UUID PRIMARY KEY REFERENCES messenger_account(id) ON DELETE CASCADE,
    profile_key         TEXT NOT NULL,
    session_encrypted   TEXT,
    session_fingerprint TEXT,
    worker_status       TEXT NOT NULL DEFAULT 'stopped',
    last_seen_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

`profile_key` указывает на persistent browser profile в volume worker. Если получится экспортировать session/cookies безопасно, они шифруются как Telegram session.

### `messenger_chat`

Использовать существующую таблицу:

- `account_id`;
- `provider_chat_id`;
- `type`: `private`, `group`, `unknown`;
- `title`;
- `last_message_preview`;
- `last_message_at`;
- `unread_count`.

### `messenger_message`

Использовать существующую таблицу:

- `provider_message_id`;
- `direction`;
- `sender_name`;
- `text`;
- `status`;
- `sent_at`;
- `raw`.

### `messenger_attachment`

Использовать существующую таблицу:

- `kind`: `photo`, `document`, `audio`, `voice`, `video`, `sticker`, `unknown`;
- `file_name`;
- `mime_type`;
- `size_bytes`;
- `storage_key` для локально скачанного файла.

## 8. API Toolkit

### Статус

`GET /api/v1/messenger/viber/status`

Ответ:

```json
{
  "configured": true,
  "connected": true,
  "account": {
    "id": "uuid",
    "display_name": "Viber",
    "phone_masked": "+375******15",
    "status": "connected"
  }
}
```

### Начать Подключение

`POST /api/v1/messenger/viber/auth/start`

API создаёт `messenger_account` в статусе `connecting`, вызывает worker и возвращает QR/инструкцию.

```json
{
  "login_id": "uuid",
  "status": "pending",
  "qr_image": "data:image/png;base64,...",
  "expires_at": "2026-04-30T12:00:00Z"
}
```

Если Viber не отдаёт QR как data payload, worker возвращает screenshot области QR.

### Poll Подключения

`GET /api/v1/messenger/viber/auth/{login_id}`

Статусы:

- `pending`;
- `confirmed`;
- `expired`;
- `error`;
- `manual_action_required`.

### Список Чатов

`GET /api/v1/messenger/viber/chats`

Возвращает локальный cache. Если cache пуст, UI показывает кнопку синхронизации.

### Синхронизация Чатов

`POST /api/v1/messenger/viber/sync`

API вызывает worker:

```text
POST http://viber-worker:8091/viber/chats/sync
```

### История Сообщений

`GET /api/v1/messenger/viber/chats/{chat_id}/messages?limit=50`

Возвращает локальный cache сообщений и вложений.

### Синхронизация Сообщений

`POST /api/v1/messenger/viber/chats/{chat_id}/sync`

Worker открывает чат в Viber-клиенте, читает последние сообщения, нормализует их и возвращает API.

### Отправка Текста/Вложений

`POST /api/v1/messenger/viber/chats/{chat_id}/messages`

Форматы:

- JSON для текста;
- `multipart/form-data` для текста + файлов.

Поля multipart:

- `text`;
- `files`.

### Скачать Вложение

`GET /api/v1/messenger/viber/attachments/{attachment_id}/download`

Если `storage_key` заполнен, API отдаёт файл из локального storage. Если файла нет, API просит worker скачать вложение из Viber-клиента.

### Отключить Сессию

`DELETE /api/v1/messenger/viber/session`

Действия:

- ставит `messenger_account.status='revoked'`;
- просит worker закрыть profile;
- не удаляет локальный cache сразу;
- retention удалит cache позже.

## 9. Internal API Worker

`viber-worker` слушает только internal network.

### Health

`GET /healthz`

### Start Login

`POST /viber/login/start`

Вход:

```json
{
  "account_id": "uuid",
  "profile_key": "uuid",
  "callback_url": "http://api:8080/api/v1/messenger-internal/viber/updates",
  "callback_secret": "secret"
}
```

Выход:

```json
{
  "login_id": "uuid",
  "status": "pending",
  "qr_image": "data:image/png;base64,...",
  "expires_at": "2026-04-30T12:00:00Z"
}
```

### Sync Chats

`POST /viber/chats/sync`

### Sync Messages

`POST /viber/messages/sync`

### Send Message

`POST /viber/messages/send`

### Download Media

`POST /viber/media/download`

### Start Updates

`POST /viber/updates/start`

Worker держит открытый persistent session и следит за новыми сообщениями.

## 10. Worker Strategy

### Этап PoC

Worker запускает browser profile:

- `chromium.launchPersistentContext(profilePath, ...)`;
- открывает Viber Web/Desktop entrypoint;
- ждёт QR/логин;
- после подтверждения сохраняет `profile_key`;
- проверяет, что после restart контейнера сессия восстанавливается.

### Извлечение Чатов

Worker должен уметь:

- получить список видимых чатов;
- извлечь title;
- извлечь unread;
- извлечь last message preview;
- извлечь stable chat id.

Если stable id в DOM отсутствует, генерировать provider_chat_id из доступных признаков нельзя для прода. Это blocker.

### Извлечение Сообщений

Worker должен уметь:

- открыть чат;
- прокрутить историю;
- извлечь message id или стабильный fingerprint;
- извлечь direction;
- извлечь sender;
- извлечь text;
- извлечь sent_at;
- извлечь attachments metadata.

Если Viber не даёт стабильный message id, использовать hash:

```text
sha256(chat_id + direction + sender + sent_at + text + attachment_names)
```

Это допустимо только для MVP, потому что возможны коллизии при одинаковых сообщениях.

### Отправка

Worker должен:

- открыть чат;
- заполнить composer;
- приложить файлы через file input или clipboard/drop;
- отправить;
- дождаться появления исходящего сообщения;
- вернуть нормализованный message.

## 11. Realtime

Минимальный realtime:

- worker держит открытый список чатов;
- отслеживает DOM changes;
- при изменении активного/нового чата запускает sync;
- отправляет callback в API.

Целевой realtime:

- один persistent browser context на Viber account;
- очередь команд на account;
- watcher событий;
- backoff reconnect;
- heartbeat `last_seen_at`.

## 12. Очереди И Concurrency

Для каждого Viber account:

- только один активный worker session;
- команды сериализуются;
- нельзя одновременно sync и send в один чат;
- долгие операции имеют timeout:
  - sync chats: 30s;
  - sync messages: 60s;
  - send text: 30s;
  - send file: 120s;
  - download media: 120s.

## 13. UI

В `Мессенджеры` добавить provider switch:

```text
Telegram | Viber
```

Для Viber:

- экран подключения;
- статус сессии;
- список чатов;
- поиск по чатам;
- thread;
- composer;
- кнопка attachment;
- preview изображений;
- player для аудио/видео;
- карточки файлов;
- состояние `Сессия Viber требует повторного входа`.

## 14. Настройки Админа

`Настройки системы -> Мессенджеры -> Viber`

Поля:

- `enabled`;
- `worker_url`;
- `session_encryption_key`;
- `retention_days`;
- `max_upload_mb`;
- `experimental_acknowledged`.

Перед включением админ должен явно подтвердить:

```text
Viber user-client является экспериментальной неофициальной интеграцией.
Она может перестать работать после обновлений Viber и может нарушать условия сервиса.
```

## 15. Безопасность

- Session/profile хранить только на сервере;
- browser не получает cookies/session;
- profile volume не монтировать в API;
- callback secret обязателен;
- attachment download проверяет владельца account;
- в логах не хранить текст сообщений, cookies, QR payload, телефоны полностью;
- файлы проверять по размеру;
- mime type выставлять безопасно;
- `Content-Disposition: attachment` для неизвестных типов.

## 16. Retention

Как Telegram:

- сообщения cache — 180 дней;
- metadata вложений — 180 дней;
- локально скачанные файлы — 180 дней;
- отключение Viber не удаляет переписку сразу;
- ручная очистка cache — отдельное действие пользователя.

## 17. Observability

Метрики:

- `viber_worker_sessions_active`;
- `viber_worker_login_success_total`;
- `viber_worker_login_failed_total`;
- `viber_worker_sync_duration_seconds`;
- `viber_worker_send_failed_total`;
- `viber_worker_dom_selector_failed_total`;
- `viber_worker_reconnect_total`.

Логи:

- account_id;
- operation;
- duration;
- status;
- error code.

Не логировать содержимое сообщений и вложений.

## 18. Этапы Работ

### Этап 0. Legal/Acceptance Gate

- зафиксировать риск неофициальной интеграции;
- определить, на каких аккаунтах можно тестировать;
- запретить подключать личные аккаунты сотрудников без письменного согласия.

### Этап 1. PoC Worker

- поднять `viber-worker`;
- проверить login;
- проверить сохранение session после restart;
- получить список чатов;
- открыть чат;
- прочитать последние сообщения.

Exit criteria:

- session переживает restart;
- есть стабильный chat id;
- можно получить последние 20 сообщений из тестового чата.

### Этап 2. DB/API

- добавить provider `viber`;
- добавить `messenger_viber_session`;
- добавить `/api/v1/messenger/viber/status`;
- добавить connect/disconnect;
- добавить chat/message endpoints.

### Этап 3. UI

- provider switch;
- Viber connect view;
- список чатов;
- thread;
- composer.

### Этап 4. Отправка И Вложения

- отправка текста;
- отправка файлов;
- чтение metadata вложений;
- download вложений;
- preview в UI.

### Этап 5. Realtime

- worker watcher;
- callback в API;
- WebSocket event;
- React invalidation.

### Этап 6. Hardening

- reconnect;
- stale session detection;
- rate limits;
- metrics;
- admin warnings;
- QA checklist.

## 19. MVP Acceptance Criteria

MVP считается готовым, если на тестовом Viber account:

- пользователь подключает Viber через Toolkit;
- session восстанавливается после restart `viber-worker`;
- отображается список личных чатов и групп;
- открывается чат;
- видны последние 50 сообщений;
- новые сообщения появляются без ручного refresh;
- можно отправить текст;
- можно отправить картинку, видео, аудио и документ;
- входящие картинки/видео/аудио/документы видны в thread;
- вложение можно скачать;
- отключение сессии работает;
- Telegram при этом продолжает работать;
- при падении `viber-worker` API и Telegram не падают.

## 20. Stop Criteria

Остановить реализацию и вернуться к официальному Bot/Business API, если:

- нет стабильного login/session restore;
- нет стабильного chat id;
- DOM/клиент Viber меняется слишком часто;
- отправка файлов требует небезопасной автоматизации;
- аккаунты получают ограничения/блокировки;
- worker требует полноценный GUI с высокой стоимостью эксплуатации;
- юридически нельзя использовать неофициальный клиент.

## 21. Рекомендация

Viber user-client держать только в изолированном worker. API, БД и UI могут быть production-ready, но фактическое чтение/отправка Viber-сообщений считается production messaging только после успешного Desktop gate:

- стабильный login;
- стабильный `provider_chat_id`;
- sync сообщений;
- отправка текста;
- восстановление session после restart;
- отсутствие влияния на Telegram и основной API.

Если Desktop gate не проходит, стабильная коммерческая интеграция должна идти через официальный Viber Bot/Business API.

## 22. Текущий Production-Контур В Toolkit

Добавлен изолированный Viber worker и production API-контур:

- `apps/viber-worker`;
- Docker Compose profiles: `viber-production`, `viber-experimental`;
- Node.js 20 + Playwright persistent context;
- profile volume: `viber_profiles`;
- provider `viber` в `messenger_account`;
- состояние аккаунта, cache чатов и сообщений в общей messenger-схеме;
- базовые endpoints:
  - `GET /healthz`;
  - `GET /readyz`;
  - `POST /viber/login/start`;
  - `GET /viber/login/{login_id}`;
  - `POST /viber/session/status`;
  - `POST /viber/session/stop`.

Запуск:

```bash
docker compose --profile viber-production up --build viber-worker
```

Подробный runbook: `docs/engineering/MESSENGER_VIBER_PRODUCTION_RUNBOOK.md`.
