# ТЗ: Мессенджер Toolkit. Этап 1 — Telegram как пользовательский клиент

## Цель

Реализовать в Toolkit раздел `Мессенджеры`, начиная с Telegram, не через bot token и не через Telegram Bot API.

Пользователь должен открыть Toolkit в браузере, подключить свой Telegram-аккаунт и работать с диалогами прямо внутри интерфейса Toolkit:

- видеть список чатов Telegram;
- читать историю переписки;
- получать новые сообщения почти в реальном времени;
- отвечать текстом;
- видеть базовые статусы доставки/ошибки;
- отключать Telegram-сессию от Toolkit.

## Важное Архитектурное Решение

Telegram-интеграция строится как пользовательский Telegram-клиент через MTProto.

Браузер Toolkit не должен напрямую хранить Telegram session string, `api_hash`, MTProto auth key или другие чувствительные данные. Браузер работает только с API Toolkit. Backend Toolkit держит Telegram-сессию пользователя, подключается к Telegram API и отдает в браузер нормализованные диалоги и сообщения.

```text
Browser Toolkit
  -> /api/v1/messenger/telegram/*
  -> Toolkit API
  -> Telegram MTProto client
  -> Telegram API
```

Почему так:

- Telegram MTProto не является обычным HTTP API для браузера.
- Telegram-сессия пользователя равна доступу к аккаунту и должна храниться как секрет.
- Backend может централизованно шифровать сессии, ограничивать доступ, логировать события и управлять rate limit.

## Не Используем

В этом этапе не используем:

- Telegram Bot API;
- bot token;
- `setWebhook` для бота;
- Telegram Mini App как основной способ переписки;
- парсинг Telegram Web через браузер/iframe;
- автоматическое управление чужими аккаунтами без явного подключения пользователем.

## Используем

Используем:

- Telegram MTProto API;
- отдельное Telegram app `api_id` и `api_hash`, полученные в `my.telegram.org`;
- server-side MTProto client library;
- вход по QR-коду как предпочтительный сценарий;
- вход по номеру телефона + code + 2FA как fallback;
- WebSocket/SSE Toolkit для доставки новых сообщений в интерфейс.

## Роли

### Пользователь

Может:

- подключить свой Telegram;
- видеть только свои Telegram-чаты;
- отправлять сообщения от своего Telegram-аккаунта;
- отключить свой Telegram от Toolkit;
- очистить локальный cache сообщений в Toolkit без удаления сообщений в Telegram.

### Администратор

Может:

- включить/выключить модуль `messengers`;
- настроить глобальные Telegram `api_id` / `api_hash`;
- видеть статус интеграции по пользователям: подключен / ошибка / отключен;
- принудительно отозвать Telegram-сессию пользователя в Toolkit.

Администратор не должен иметь доступ к содержимому личных Telegram-чатов пользователя, если нет отдельного юридического/продуктового решения.

## Управление Telegram-Учётными Записями

Telegram-аккаунт подключает сам пользователь в своём интерфейсе Toolkit. Администратор не вводит номер, код, QR или 2FA-пароль за пользователя.

Такое разделение обязательно, потому что Telegram-сессия даёт доступ к реальному аккаунту. Подключение должно быть явным действием владельца аккаунта или сотрудника, у которого есть легитимный доступ к общему рабочему Telegram.

### Что Делает Администратор

В админских настройках мессенджеров администратор:

- включает или выключает модуль `Мессенджеры`;
- настраивает глобальные `TELEGRAM_API_ID` и `TELEGRAM_API_HASH`;
- задаёт политики интеграции:
  - разрешено переиспользование одного Telegram-аккаунта несколькими пользователями Toolkit;
  - retention сообщений и локально скачанных вложений — 180 дней;
  - лимиты размера вложений;
- видит список подключений:
  - пользователь Toolkit;
  - Telegram display name;
  - Telegram username;
  - masked phone;
  - статус: `connected`, `error`, `revoked`;
  - время последней синхронизации;
- может принудительно отозвать Telegram-сессию пользователя в Toolkit.

Администратор не видит Telegram session string, коды входа, 2FA-пароли и содержимое сообщений в админском списке подключений.

### Что Делает Пользователь

Пользователь:

- открывает `Мессенджеры -> Telegram`;
- нажимает `Подключить Telegram`;
- сканирует QR-код своим Telegram или использует вход по номеру;
- вводит код и 2FA-пароль, если Telegram их запросил;
- после подключения работает со своими чатами в Toolkit;
- может отключить Telegram от Toolkit.

### Общий Рабочий Telegram

Если компания использует общий рабочий Telegram-аккаунт, его подключает сотрудник, у которого уже есть доступ к этому аккаунту. Один и тот же Telegram-аккаунт разрешено подключить нескольким пользователям Toolkit, но каждое подключение создаёт отдельную зашифрованную сессию.

## Область Работ Этапа 1

Этап 1 описывает целевую функциональность первого большого релиза Telegram-мессенджера. Для разработки этот этап делится на `MVP v1` и `v1.1`, чтобы быстро получить рабочий Telegram в Toolkit и затем расширить его без переделки архитектуры.

Входит:

- backend-модуль Telegram MTProto;
- хранение Telegram-сессии пользователя;
- подключение аккаунта через QR-код;
- fallback-подключение через номер телефона, код и 2FA;
- список личных диалогов и групп;
- история сообщений: при первом открытии чата загружать до 500 последних сообщений;
- отправка текстовых сообщений;
- вложения в сообщениях: просмотр, скачивание и отправка фото, документов, аудио, голосовых и видео;
- realtime обновления входящих/исходящих сообщений;
- UI раздела `Мессенджеры`;
- базовые ошибки и повторное подключение;
- audit/security события.

Не входит:

- боты;
- WhatsApp;
- Instagram/Viber/прочие каналы;
- групповые операции CRM;
- автоворонки;
- массовые рассылки;
- секретные чаты Telegram;
- каналы Telegram;
- звонки Telegram;
- удаление/редактирование сообщений;
- реакции, треды, stories;
- привязка Telegram-чата к CRM-контакту/сделке;
- полноценный sync всех старых сообщений при первом подключении.

## MVP v1

Цель MVP v1 — дать пользователю рабочий Telegram inbox внутри Toolkit с минимальным, но полезным набором возможностей.

Входит в MVP v1:

- админ включает модуль `Мессенджеры`;
- админ настраивает `TELEGRAM_API_ID` и `TELEGRAM_API_HASH`;
- пользователь подключает Telegram через QR-код;
- один Telegram-аккаунт можно подключить нескольким пользователям Toolkit;
- список личных чатов и групп;
- открытие чата;
- быстрый показ последних 50 сообщений;
- фоновая догрузка cache до 500 последних сообщений выбранного чата;
- отправка текстовых сообщений;
- отправка вложений: фото, документы, аудио, голосовые и видео;
- realtime новых текстовых сообщений;
- отображение входящих и исходящих вложений как карточек в thread;
- скачивание вложений через backend;
- отключение Telegram-сессии пользователем;
- retention сообщений и локально скачанных вложений 180 дней;
- базовые ошибки: не настроен Telegram, QR истёк, сессия отозвана, rate limit.

Не входит в MVP v1:

- вход по номеру телефона, коду и 2FA;
- статусы `delivered/read`;
- поиск по сообщениям;
- админский просмотр детального списка подключений;
- админский принудительный revoke;
- CRM-привязка.

## v1.1

Входит в v1.1:

- fallback-вход по номеру телефона;
- ввод Telegram-кода;
- ввод Telegram 2FA-пароля;
- статусы доставки/прочтения, если библиотека и Telegram events дают их стабильно;
- поиск по локальному cache;
- админский список подключений;
- админский принудительный revoke Telegram-сессии пользователя;
- улучшенный reconnect UI.

## Политика Переиспользования Telegram-Аккаунта

Разрешаем подключать один и тот же Telegram-аккаунт к нескольким пользователям Toolkit.

Это нужно для сценариев, где один общий рабочий Telegram используется несколькими сотрудниками. При этом:

- у каждого пользователя Toolkit своя зашифрованная Telegram-сессия;
- отключение Telegram у одного пользователя не отключает других;
- локальный cache чатов и сообщений привязан к `messenger_account`, то есть к конкретной паре `user_id + provider`;
- в админском статусе нужно показывать, что один Telegram `provider_user_id` используется несколькими пользователями;
- отправка сообщений всегда выполняется от Telegram-сессии текущего пользователя Toolkit.

## Пользовательские Сценарии

### Подключить Telegram Через QR

1. Пользователь открывает `Мессенджеры -> Telegram`.
2. Если Telegram не подключен, Toolkit показывает экран подключения.
3. Пользователь нажимает `Подключить Telegram`.
4. Backend создает QR login token через MTProto.
5. Frontend показывает QR-код.
6. Пользователь сканирует QR в Telegram на телефоне.
7. После подтверждения backend получает авторизованную Telegram-сессию.
8. Toolkit сохраняет зашифрованную session string.
9. UI переходит в список чатов.

### Подключить Telegram По Номеру

Fallback, если QR недоступен:

1. Пользователь вводит номер телефона.
2. Backend вызывает отправку кода Telegram.
3. Пользователь вводит код.
4. Если включена 2FA, Toolkit запрашивает пароль Telegram 2FA.
5. После успешного входа Toolkit сохраняет сессию.

### Читать Диалоги

1. Пользователь открывает `Мессенджеры`.
2. UI загружает список Telegram-диалогов.
3. Пользователь выбирает диалог.
4. UI загружает последние сообщения.
5. Новые сообщения приходят через Toolkit realtime канал.

### Отправить Сообщение

1. Пользователь пишет текст.
2. UI отправляет `POST /telegram/chats/{chat_id}/messages`.
3. Backend отправляет сообщение через MTProto от имени Telegram-аккаунта пользователя.
4. Сообщение появляется в UI со статусом `sending`.
5. После подтверждения статус меняется на `sent`.
6. При ошибке статус становится `failed`, UI предлагает повторить.

## Backend Архитектура

Предлагаемая структура:

```text
apps/api/internal/messenger/
  service.go
  handlers.go
  models.go
  realtime.go

apps/api/internal/messenger/telegram/
  client.go
  auth.go
  sync.go
  mapper.go
  session_store.go
```

### Основные Компоненты

`telegram.ClientManager`

- создает MTProto client для пользователя;
- восстанавливает client из сохраненной session string;
- держит активные подключения в памяти;
- умеет reconnect;
- закрывает client при logout/revoke.

`telegram.SessionStore`

- сохраняет зашифрованную Telegram-сессию;
- читает сессию по `user_id`;
- удаляет сессию при отключении.

`messenger.Service`

- нормализует Telegram-данные в общий формат Toolkit;
- проверяет права доступа;
- управляет sync и realtime-событиями.

`messenger.Realtime`

- публикует события в существующий WebSocket Toolkit:
  - `messenger.telegram.connected`;
  - `messenger.telegram.disconnected`;
  - `messenger.chat.updated`;
  - `messenger.message.created`;
  - `messenger.message.status_changed`.

## Хранение Данных

### `messenger_account`

Одна строка на подключенный внешний аккаунт.

```sql
CREATE TABLE messenger_account (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    provider            TEXT NOT NULL CHECK (provider IN ('telegram')),
    provider_user_id    TEXT NOT NULL,
    display_name        TEXT NOT NULL DEFAULT '',
    username            TEXT NOT NULL DEFAULT '',
    phone_masked        TEXT NOT NULL DEFAULT '',
    status              TEXT NOT NULL DEFAULT 'connected'
        CHECK (status IN ('connecting', 'connected', 'error', 'revoked')),
    error_message       TEXT,
    connected_at        TIMESTAMPTZ,
    last_sync_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, provider)
);
```

`provider_user_id` не уникален глобально, потому что один Telegram-аккаунт разрешено подключать нескольким пользователям Toolkit.

### `messenger_telegram_session`

Секретная таблица. Не отдавать в API.

```sql
CREATE TABLE messenger_telegram_session (
    account_id              UUID PRIMARY KEY REFERENCES messenger_account(id) ON DELETE CASCADE,
    session_encrypted       TEXT NOT NULL,
    session_fingerprint     TEXT NOT NULL,
    dc_id                   INTEGER,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

`session_encrypted` шифровать через тот же подход, который используется для Bitrix refresh token.

### `messenger_chat`

Локальный cache диалогов.

```sql
CREATE TABLE messenger_chat (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id          UUID NOT NULL REFERENCES messenger_account(id) ON DELETE CASCADE,
    provider_chat_id    TEXT NOT NULL,
    type                TEXT NOT NULL CHECK (type IN ('private', 'group', 'channel', 'bot', 'unknown')),
    title               TEXT NOT NULL DEFAULT '',
    avatar_file_id      TEXT,
    unread_count        INTEGER NOT NULL DEFAULT 0,
    last_message_at     TIMESTAMPTZ,
    last_message_preview TEXT NOT NULL DEFAULT '',
    pinned              BOOLEAN NOT NULL DEFAULT FALSE,
    muted               BOOLEAN NOT NULL DEFAULT FALSE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (account_id, provider_chat_id)
);
```

### `messenger_message`

Локальный cache сообщений. Сообщения хранятся с retention 180 дней. Telegram остается основным источником истории, Toolkit хранит сообщения для быстрого интерфейса, поиска в свежей переписке и realtime-работы.

```sql
CREATE TABLE messenger_message (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_id                 UUID NOT NULL REFERENCES messenger_chat(id) ON DELETE CASCADE,
    provider_message_id     TEXT NOT NULL,
    direction               TEXT NOT NULL CHECK (direction IN ('in', 'out')),
    sender_provider_id      TEXT,
    sender_name             TEXT NOT NULL DEFAULT '',
    text                    TEXT NOT NULL DEFAULT '',
    status                  TEXT NOT NULL DEFAULT 'sent'
        CHECK (status IN ('sending', 'sent', 'delivered', 'read', 'failed')),
    sent_at                 TIMESTAMPTZ NOT NULL,
    edited_at               TIMESTAMPTZ,
    raw                     JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (chat_id, provider_message_id)
);
```

### `messenger_attachment`

Локальный cache метаданных вложений. Сам файл на первом этапе можно хранить как Telegram file reference и скачивать по требованию через backend. Если файл скачан в Toolkit storage, заполняется `storage_key`.

```sql
CREATE TABLE messenger_attachment (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id              UUID NOT NULL REFERENCES messenger_message(id) ON DELETE CASCADE,
    provider_file_id        TEXT NOT NULL,
    kind                    TEXT NOT NULL CHECK (kind IN ('photo', 'document', 'audio', 'voice', 'video', 'sticker', 'unknown')),
    file_name               TEXT NOT NULL DEFAULT '',
    mime_type               TEXT NOT NULL DEFAULT '',
    size_bytes              BIGINT,
    width                   INTEGER,
    height                  INTEGER,
    duration_sec            INTEGER,
    storage_key             TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

## API Контракты

Все endpoint'ы требуют авторизации Toolkit.

### Статус Telegram

`GET /api/v1/messenger/telegram/status`

```json
{
  "connected": true,
  "account": {
    "id": "uuid",
    "display_name": "Ivan",
    "username": "ivan",
    "phone_masked": "+375******15",
    "status": "connected",
    "last_sync_at": "2026-04-30T12:00:00Z"
  }
}
```

### Начать QR Login

`POST /api/v1/messenger/telegram/auth/qr/start`

Ответ:

```json
{
  "login_id": "uuid",
  "qr_payload": "tg://login?token=...",
  "expires_at": "2026-04-30T12:01:00Z"
}
```

### Проверить QR Login

`GET /api/v1/messenger/telegram/auth/qr/{login_id}`

Ответы:

```json
{ "status": "pending" }
```

```json
{ "status": "confirmed" }
```

```json
{ "status": "expired" }
```

### Login По Телефону

`POST /api/v1/messenger/telegram/auth/phone/start`

```json
{ "phone": "+375447006015" }
```

Ответ:

```json
{
  "login_id": "uuid",
  "code_delivery": "telegram_app"
}
```

`POST /api/v1/messenger/telegram/auth/phone/confirm`

```json
{
  "login_id": "uuid",
  "code": "12345"
}
```

Если нужна 2FA:

```json
{
  "status": "password_required",
  "hint": "m***"
}
```

`POST /api/v1/messenger/telegram/auth/phone/password`

```json
{
  "login_id": "uuid",
  "password": "telegram-2fa-password"
}
```

### Отключить Telegram

`DELETE /api/v1/messenger/telegram/session`

Должно:

- удалить локальную encrypted session;
- закрыть активный MTProto client;
- пометить account как `revoked`;
- не удалять переписку в самом Telegram.

### Список Чатов

`GET /api/v1/messenger/telegram/chats?limit=50&cursor=...`

```json
{
  "items": [
    {
      "id": "uuid",
      "provider_chat_id": "123456",
      "type": "private",
      "title": "Иван Иванов",
      "unread_count": 2,
      "last_message_preview": "Добрый день",
      "last_message_at": "2026-04-30T12:00:00Z",
      "muted": false,
      "pinned": false
    }
  ],
  "next_cursor": "..."
}
```

### История Сообщений

`GET /api/v1/messenger/telegram/chats/{chat_id}/messages?limit=50&before=...`

При первом открытии чата frontend должен запросить 50 сообщений для быстрого отображения, а backend фоном догружает локальный cache до 500 последних сообщений этого чата. UI может дозагрузить следующую страницу из cache/API.

```json
{
  "items": [
    {
      "id": "uuid",
      "direction": "in",
      "sender_name": "Иван Иванов",
      "text": "Добрый день",
      "status": "sent",
      "sent_at": "2026-04-30T12:00:00Z",
      "attachments": [
        {
          "id": "uuid",
          "kind": "photo",
          "file_name": "photo.jpg",
          "mime_type": "image/jpeg",
          "size_bytes": 120000,
          "download_url": "/api/v1/messenger/telegram/attachments/{attachment_id}/download"
        }
      ]
    }
  ],
  "next_cursor": "..."
}
```

### Скачать Вложение

`GET /api/v1/messenger/telegram/attachments/{attachment_id}/download`

Backend проверяет, что вложение принадлежит Telegram-аккаунту текущего пользователя. Если файла нет в локальном storage, backend скачивает его из Telegram и отдает stream браузеру.

### Отправить Сообщение Или Вложения

`POST /api/v1/messenger/telegram/chats/{chat_id}/messages`

Для текстового сообщения допустим JSON:

```json
{
  "text": "Здравствуйте"
}
```

Для сообщения с файлами используется `multipart/form-data`:

- `text` — подпись/текст сообщения, опционально если есть файл;
- `files` — один или несколько файлов.

Ответ:

```json
{
  "items": [
    {
      "id": "uuid",
      "direction": "out",
      "text": "Здравствуйте",
      "status": "sent",
      "sent_at": "2026-04-30T12:00:10Z",
      "attachments": []
    }
  ]
}
```

## Realtime События

Через существующий Toolkit WebSocket.

### Новое Сообщение

```json
{
  "type": "messenger.message.created",
  "payload": {
    "provider": "telegram",
    "chat_id": "uuid",
    "message": {
      "id": "uuid",
      "direction": "in",
      "text": "Привет",
      "sent_at": "2026-04-30T12:00:00Z"
    }
  }
}
```

### Обновление Чата

```json
{
  "type": "messenger.chat.updated",
  "payload": {
    "provider": "telegram",
    "chat_id": "uuid",
    "unread_count": 3,
    "last_message_preview": "Привет"
  }
}
```

## Frontend

### Маршрут

Текущий sidebar уже содержит `Мессенджеры` как stub. Нужно заменить stub на реальную страницу.

Предлагаемая структура:

```text
apps/web/src/messenger/
  MessengerPage.tsx
  api.ts
  ws.ts
  types.ts
  telegram/
    TelegramConnectView.tsx
    TelegramInboxView.tsx
    ChatList.tsx
    MessageThread.tsx
    MessageComposer.tsx
```

### Первый Экран

Если Telegram не подключен:

- заголовок `Telegram`;
- кнопка `Подключить Telegram`;
- QR-код;
- ссылка `Войти по номеру`;
- короткое предупреждение: `Toolkit получит доступ к вашему Telegram-аккаунту как клиент. Подключайте только свой аккаунт.`

### Основной Экран

Layout:

```text
┌──────────────────────────────────────────────┐
│ Мессенджеры / Telegram        статус         │
├───────────────┬──────────────────────────────┤
│ Поиск         │ Имя чата                     │
│ Чат 1         │ сообщения                    │
│ Чат 2         │                              │
│ Чат 3         │ поле ввода + отправить       │
└───────────────┴──────────────────────────────┘
```

Минимальные элементы:

- список чатов;
- поиск по локально загруженным чатам;
- unread badge;
- thread выбранного чата;
- composer;
- кнопка `Отключить Telegram`.

## Безопасность

Обязательные требования:

- `api_hash` хранить только на backend в env/config.
- Telegram session string хранить только encrypted-at-rest.
- Не отдавать Telegram session string в браузер.
- Все API проверяют `auth.Subject.UserID`.
- Пользователь видит только свой `messenger_account`.
- Логировать login/revoke/error без текста сообщений.
- Не писать код/пароль 2FA в логи.
- Ограничить попытки login code/2FA через rate limit.
- При смене пароля/отзыве сессии показывать `Требуется повторное подключение`.
- Сообщения и вложения хранить как cache с retention 180 дней.
- Retention job должен удалять старые `messenger_message` и локально скачанные `messenger_attachment`, не удаляя ничего в Telegram.

## Ограничения Telegram

- Секретные чаты не синхронизируются через обычный server-side клиент.
- Каналы не синхронизируются на первом этапе: только личные чаты и группы.
- Telegram может ограничивать частые запросы и отправку сообщений.
- Для полноценной работы нужен стабильный long-running процесс, который держит MTProto update loop.
- QR login требует подтверждения в уже авторизованном Telegram-клиенте.
- Если Telegram прислал Flood Wait, backend должен сохранять ошибку и показывать понятный retry-after.

## Переменные Окружения

```env
TELEGRAM_API_ID=123456
TELEGRAM_API_HASH=...
TELEGRAM_SESSION_ENCRYPTION_KEY=base64...
TELEGRAM_SYNC_ENABLED=true
TELEGRAM_MAX_ACTIVE_CLIENTS=100
```

## Ошибки

Единый формат:

```json
{
  "error": {
    "code": "telegram_password_required",
    "message": "Для входа нужен пароль двухфакторной защиты"
  }
}
```

Коды:

- `telegram_not_configured`;
- `telegram_already_connected`;
- `telegram_login_expired`;
- `telegram_code_invalid`;
- `telegram_password_required`;
- `telegram_password_invalid`;
- `telegram_session_revoked`;
- `telegram_rate_limited`;
- `telegram_send_failed`.

## Этапы Реализации

### MVP v1. Этап 1. Backend Основа

- миграции таблиц;
- config `TELEGRAM_API_ID/API_HASH`;
- encrypted session store;
- skeleton `internal/messenger`;
- status/connect/disconnect endpoints.

### MVP v1. Этап 2. QR Авторизация

- QR login;
- revoke session.

### MVP v1. Этап 3. Inbox

- список личных чатов и групп;
- локальный cache `messenger_chat`;
- загрузка последних 500 сообщений выбранного чата;
- basic pagination.

### MVP v1. Этап 4. Текстовые Сообщения

- composer;
- optimistic message;
- отправка через MTProto;
- status `sending/sent/failed`;
- retry failed.

### MVP v1. Этап 5. Вложения

- прием метаданных вложений;
- отображение фото/документов/аудио/голосовых/видео в thread;
- download endpoint через backend;
- lazy download из Telegram;
- отправка вложений через multipart composer и MTProto;
- ограничения размера и безопасные mime-type headers.

### MVP v1. Этап 6. Realtime

- Telegram update loop;
- запись новых сообщений в DB;
- публикация в Toolkit WebSocket;
- обновление unread и last message.

### MVP v1. Этап 7. Полировка

- skeleton/loading/error states;
- reconnect UI;
- аудит событий.

### v1.1. Расширение

- phone login fallback;
- 2FA password step;
- админский статус подключений;
- админский revoke;
- поиск по cache;
- статусы доставки/прочтения.

## Definition Of Done

MVP v1 считается готовым, если:

- пользователь может подключить свой Telegram через QR;
- пользователь видит список личных чатов и групп;
- пользователь открывает чат и видит последние 500 сообщений после фоновой догрузки;
- новые сообщения приходят без ручного refresh;
- пользователь отправляет текстовое сообщение;
- пользователь видит, скачивает и отправляет вложения;
- после logout/login Toolkit Telegram-сессия восстанавливается;
- пользователь может отключить Telegram;
- один Telegram-аккаунт может быть подключен несколькими пользователями Toolkit;
- личные чаты и группы синхронизируются, каналы не синхронизируются;
- сообщения и локально скачанные вложения удаляются retention-job через 180 дней;
- Telegram-чаты не привязываются к CRM-контактам/сделкам на первом этапе;
- session string не попадает в frontend, логи и API responses;
- все endpoint'ы покрыты auth-check;
- есть миграции up/down;
- есть smoke test backend API;
- есть ручной сценарий проверки в docs/worklog или отдельном QA checklist.

v1.1 считается готовым, если дополнительно:

- пользователь может подключиться по номеру, коду и 2FA;
- админ видит список подключений;
- админ может принудительно отозвать Telegram-сессию пользователя;
- работает поиск по локальному cache.

## Зафиксированные Решения

- Telegram подключается как пользовательский клиент через MTProto, не через бота.
- Администратор настраивает Telegram-интеграцию, но не подключает Telegram-аккаунты за пользователей.
- В MVP v1 Telegram-аккаунт подключает сам пользователь через QR.
- Вход по номеру, коду и 2FA переносится в v1.1.
- Один Telegram-аккаунт можно подключать нескольким пользователям Toolkit.
- Синхронизируются только личные чаты и группы.
- Каналы Telegram не синхронизируются на первом этапе.
- При первом открытии чата догружается до 500 последних сообщений.
- Сообщения и локально скачанные вложения хранятся как cache с retention 180 дней.
- Привязка Telegram-чата к CRM-контакту/сделке не входит в первый этап.
