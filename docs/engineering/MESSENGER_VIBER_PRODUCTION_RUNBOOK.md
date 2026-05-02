# Viber User-Client Production Runbook

## Назначение

Этот документ описывает production-контур Viber в Toolkit: что уже является стабильной частью системы, что остаётся Desktop gate, и как безопасно продолжать внедрение.

## Текущий Контур

- `apps/viber-worker` запускается отдельным сервисом и не делит процесс с API.
- Docker profile: `viber-production`.
- API работает только через `/api/v1/messenger/viber/*`; браузер не обращается к worker напрямую.
- Provider `viber` разрешён в `messenger_account`.
- Состояние подключения хранится в `messenger_account`.
- Доступ пользователей к аккаунту хранится в `messenger_account_access`; владелец аккаунта получает роль `owner`, администратор может выдавать и отзывать роль `member` в `Настройки системы -> Мессенджеры -> Аккаунты и доступ`.
- Чаты и сообщения Viber используют общие таблицы `messenger_chat`, `messenger_message`, `messenger_attachment`.
- Если worker недоступен или Desktop target ещё не готов, Telegram и остальной Toolkit продолжают работать.

## Запуск

```bash
docker compose --profile viber-production up -d --build viber-worker api worker web-build
docker compose --profile viber-production up -d web
```

Проверка worker:

```bash
curl -fsS http://localhost:8091/healthz
curl -fsS http://localhost:8091/readyz
```

Проверка через Toolkit API выполняется из браузера авторизованного пользователя:

```text
GET /api/v1/messenger/viber/status
POST /api/v1/messenger/viber/auth/start
GET /api/v1/messenger/viber/chats
```

## Конфигурация

```env
VIBER_WORKER_URL=http://viber-worker:8091
VIBER_CLIENT_MODE=browser
VIBER_DESKTOP_COMMAND=
VIBER_QR_SELECTOR=
VIBER_HEADLESS=true
VIBER_LOGIN_TTL_MS=300000
VIBER_STAGE=production
```

Для реальных чатов нужен `VIBER_CLIENT_MODE=desktop` и установленный Desktop runtime. Browser mode оставлен как диагностический режим: он проверяет worker, profile volume и screenshot pipeline, но `account.viber.com` не является полноценным Viber messenger.

## Acceptance Criteria Для Production Messaging

Viber messaging можно считать production-ready только после прохождения всех пунктов:

- пользователь подключает Viber через Toolkit;
- Viber Desktop session восстанавливается после restart `viber-worker`;
- worker извлекает стабильный `provider_chat_id`;
- sync возвращает список чатов и сохраняет его в `messenger_chat`;
- sync последних сообщений сохраняет данные в `messenger_message`;
- отправка текста через Toolkit появляется в Viber Desktop;
- падение или рестарт `viber-worker` не влияет на Telegram;
- UI показывает понятную ошибку, если Viber runtime недоступен.

## Риски

Viber user-client является неофициальным способом интеграции. DOM/GUI Viber Desktop может измениться без предупреждения. Для стабильного коммерческого канала предпочтителен официальный Viber Bot/Business API, если бизнес-процесс допускает работу от имени bot/business account.
