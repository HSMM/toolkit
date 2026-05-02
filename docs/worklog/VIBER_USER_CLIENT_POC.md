# Viber User-Client Production Track

## Цель

Довести Viber user-client до production-контура внутри Toolkit, не затрагивая Telegram и основной backend.

## Что Сделано

- Добавлен `apps/viber-worker`.
- Стек worker:
  - Node.js 20;
  - Express;
  - Playwright Chromium persistent context;
  - Docker image `mcr.microsoft.com/playwright:v1.48.2-jammy`;
  - Docker volume `viber_profiles`.
- Добавлен compose service `viber-worker` под профилями `viber-production` и `viber-experimental`.
- Добавлен provider `viber` в `messenger_account`.
- Toolkit API сохраняет состояние Viber-аккаунта в БД.
- Toolkit API читает Viber-чаты и сообщения из общего messenger cache.
- Sync/send ответы worker сохраняются в `messenger_chat` / `messenger_message`.
- Worker получил `GET /readyz`, production stage и cleanup устаревших login-сессий.
- Worker умеет:
  - `GET /healthz`;
  - `POST /viber/login/start`;
  - `GET /viber/login/{login_id}`;
  - `POST /viber/session/status`;
  - `POST /viber/session/stop`.
- Chat/message/send/media/update endpoints worker пока возвращают `501`, пока не подтверждён стабильный Viber Desktop target и selectors.

## Запуск Production Runtime

```bash
docker compose --profile viber-production up --build viber-worker
```

Проверка health:

```bash
curl -fsS http://localhost:8091/healthz
curl -fsS http://localhost:8091/readyz
```

Старт login-сессии:

```bash
curl -fsS -X POST http://localhost:8091/viber/login/start \
  -H 'Content-Type: application/json' \
  -d '{"account_id":"test-viber","profile_key":"test-viber"}'
```

Worker вернёт screenshot страницы входа. Если найден стабильный selector QR-кода, можно задать:

```env
VIBER_QR_SELECTOR=<css selector>
```

## Текущий Production Gate

Viber считается production-ready только если:

- Viber entry URL открывается в worker;
- можно пройти login;
- persistent profile переживает restart container;
- можно извлечь стабильный chat id из Viber Desktop;
- можно извлечь последние сообщения из тестового чата;
- можно отправить сообщение в тестовый чат;
- session переживает restart worker/container;
- падение `viber-worker` не ломает Telegram и API.

Если stable chat id недоступен, user-client реализацию нельзя считать production messaging. В этом случае production-вариант для коммерческого канала — официальный Viber Bot/Business API.

## Проверка На Сервере 10.10.0.17

Дата: 2026-04-30.

Что проверено:

- код синхронизирован в `/opt/toolkit`;
- `viber-worker` собран на сервере;
- worker запущен через compose profile `viber-experimental`;
- `GET /healthz` отвечает;
- `POST /viber/login/start` создаёт persistent Playwright session и возвращает screenshot;
- `POST /viber/session/status` показывает активную session.

Результат:

```json
{
  "connected": true,
  "status": "running",
  "account_id": "poc-viber",
  "profile_key": "poc-viber",
  "title": "Доступные тарифы на звонки в любые страны | Viber Out",
  "url": "https://account.viber.com/ru/"
}
```

Вывод:

- browser worker технически работает;
- Playwright persistent profile на сервере создаётся;
- `https://account.viber.com/` не является Viber messenger web-client, это страница Viber Out;
- для user-client интеграции следующий PoC должен идти через Viber Desktop Linux/AppImage под Xvfb/Wine/GUI automation, а не через обычный browser page.

Следующий шаг:

- расширить текущий worker режимом `VIBER_CLIENT_MODE=desktop`;
- скачать официальный Viber Desktop for Linux;
- поднять его в контейнере с Xvfb;
- проверить, появляется ли QR login и где хранится desktop profile;
- проверить, переживает ли session restart контейнера.
