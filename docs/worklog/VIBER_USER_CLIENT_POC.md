# Viber User-Client PoC

## Цель

Проверить, можно ли безопасно и воспроизводимо держать Viber user-client сессию в отдельном worker, не затрагивая Telegram и основной backend.

## Что Сделано

- Добавлен `apps/viber-worker`.
- Стек worker:
  - Node.js 20;
  - Express;
  - Playwright Chromium persistent context;
  - Docker image `mcr.microsoft.com/playwright:v1.48.2-jammy`;
  - Docker volume `viber_profiles`.
- Добавлен compose service `viber-worker` под профилем `viber-experimental`.
- Worker умеет:
  - `GET /healthz`;
  - `POST /viber/login/start`;
  - `GET /viber/login/{login_id}`;
  - `POST /viber/session/status`;
  - `POST /viber/session/stop`.
- Chat/message/send/media/update endpoints пока возвращают `501`, пока не подтверждён стабильный Viber client target и selectors.

## Запуск PoC

```bash
docker compose --profile viber-experimental up --build viber-worker
```

Проверка health:

```bash
curl -fsS http://localhost:8091/healthz
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

## Следующий Gate

PoC можно продолжать только если:

- Viber entry URL открывается в worker;
- можно пройти login;
- persistent profile переживает restart container;
- можно извлечь стабильный chat id;
- можно извлечь последние сообщения из тестового чата.

Если хотя бы stable chat id недоступен, user-client реализацию останавливаем и возвращаемся к официальному Viber Bot/Business API.
