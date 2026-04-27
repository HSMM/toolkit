# apps/web

SPA Toolkit. **React 18 + TypeScript + Vite + react-router-dom + TanStack Query + lucide-react + i18next + Playwright**.

## Что реализовано

**Каркас:**
- Vite 5, React 18, TypeScript strict, алиас `@/*` → `src/*`.
- Dev-server `:5173` с прокси `/api`, `/oauth`, `/healthz`, `/version` на backend.
- `Shell.tsx` — единый layout (sidebar/header), `App.tsx` — public path-router (`/g/<token>` для гостей обходит auth gate).

**API client / state:**
- `src/api/client.ts` — типизированный fetch с обработкой 401 (auto-logout) и `ApiError {status, code, message, details}`.
- TanStack Query v5 c разумными дефолтами (staleTime 30s, retry только для 5xx).
- Хуки по доменам: `meetings.ts`, `transcripts.ts`, `system-settings.ts`, `admin.ts`, `me.ts`.
- WebSocket: `src/ws/wsClient.ts` с reconnect 1→30s, Bearer через subprotocol `bearer.<jwt>`. `useWsClient()` + `useWsEvent(type, handler)`.

**Auth:**
- `AuthContext` — `loading|anonymous|authenticated`, восстановление через `/oauth/refresh`, `login()`/`logout()`.
- `Login.tsx` — CTA «Войти через Bitrix24» → редирект на `/oauth/login`.

**Реализованные модули:**
- **Видеоконференции** (`Shell.tsx::VcsPage` + `MeetingRoom.tsx` + `RoomUI.tsx`):
  список встреч, форма создания (instant/scheduled), live-таймер, бейдж записи,
  кнопка «Гостевая ссылка», dropdown «Записи» для скачивания MP4/OGG, custom
  RU-UI комнаты на примитивах LiveKit (`GridLayout` + `ParticipantTile` +
  `useTrackToggle` + custom `ChatPanel`).
- **Гостевой вход** (`GuestPage.tsx`): public route `/g/<token>`, форма имени →
  POST `/request` → polling status каждые 2с → авто-вход когда host допустил.
- **Транскрибация** (`TranscriptionPage.tsx`): загрузка аудио, список с прогрессом,
  viewer с диалогом по каналам, экспорт TXT, ручная правка.
- **Софтфон** (`SoftphoneWidget` + `softphone/useSoftphone.ts`): JsSIP-клиент к
  FreePBX, state-machine (`not_configured / connecting / registered / incoming
  / outgoing / active / ended`), dialer / mute / hold / hangup, popup на входящий
  + OS-нотификация. Креды подтягиваются из `/system-settings/phone/me`.
- **Настройки системы** (`Shell.tsx`, 4 таба): Пользователи (роли/блокировка
  кликом + кнопка Bitrix-синка), Доступ к модулям, Телефония (WebRTC шлюз с
  user-picker + AMI), SMTP. Все 4 — реальная персистенция через API.
- **Мониторинг АТС** — перенесён в админ-меню.
- **OS-уведомления**: `AppCtx.osPerm` + `requestOSPerm`, `push()` дублирует
  в notification center когда вкладка не в фокусе. NotificationBell показывает
  CTA «Включить» если permission=default.

**i18n:** только русский (ТЗ 5.4). Большинство строк inline (паттерн прототипа);
ключи `src/i18n/ru.json` для общих секций.

**E2E:** `tests/e2e/login.spec.ts` (Playwright Chromium / Firefox / WebKit).
Run: `npm run e2e` при запущенном dev-сервере.

## Что не реализовано (известные пробелы MVP)

- Приглашение участников встречи по email + поиск (мульти-селектор поверх
  свежесинхронизированной таблицы `user`).
- Политики записи / GDPR-запросы / Audit-log — отдельные страницы в Настройках.
- Реальная end-to-end проверка софтфона с боевым FreePBX-extension'ом.
- AMI-вкладка в Настройках телефонии — UI готов, реальное подключение нет.

## Запуск

### Local dev (нужен Node 20+ на хосте)

```bash
cd apps/web
npm install
VITE_API_TARGET=http://localhost:8080 npm run dev
# Vite на http://localhost:5173, прокси на api:8080
```

### Через docker-compose (production-like)

```bash
# Из корня проекта:
docker compose up -d
# web-build один раз компилирует SPA в общий volume web_dist;
# web (nginx) серверит статику + проксирует /api, /oauth, /rtc.
```

После изменений в `apps/web/*` — пересобрать:

```bash
make web-rebuild
```

### Тесты

```bash
npm run typecheck      # tsc --noEmit
npm test               # vitest unit
npm run e2e            # playwright (на запущенном dev-server)
```

## Структура

```
apps/web/
├── src/
│   ├── api/              — fetch-клиент, React Query, генерация типов
│   ├── auth/             — AuthContext + Login
│   ├── ws/               — WsClient + React-хуки
│   ├── i18n/             — react-i18next + ru.json
│   ├── styles/           — tokens, globals.css
│   ├── components/       — общие примитивы (Empty/Loading/Error)
│   ├── layouts/          — AppLayout + Sidebar
│   ├── modules/
│   │   ├── phone/        — Софтфон (заглушка)
│   │   ├── meet/         — ВКС (заглушка)
│   │   ├── transcripts/  — Транскрибация (заглушка)
│   │   ├── admin/        — Админ-панель (заглушка)
│   │   ├── stubs/        — Мессенджеры/Контакты/Хелпдэск (плейсхолдеры MVP)
│   │   └── StubPage.tsx  — общий шаблон заглушки
│   ├── App.tsx           — роутер
│   └── main.tsx          — точка входа
├── tests/e2e/            — Playwright-сценарии
├── public/               — статика favicon и т.п.
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
├── playwright.config.ts
├── Dockerfile            — multi-stage: build → nginx (target=build для compose)
└── README.md
```
