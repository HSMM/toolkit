# apps/web

SPA Toolkit. **React 18 + TypeScript + Vite + react-router-dom + TanStack Query + lucide-react + i18next + Playwright**.

## Что уже есть (E4.1–E4.7)

**Каркас (E4.1):**
- Vite 5, React 18, TS strict.
- Алиас `@/*` → `src/*`.
- Dev-server на `:5173` с прокси `/api`, `/oauth`, `/healthz`, `/version` на backend.

**Роутинг и layout (E4.2):**
- `BrowserRouter` + защищённые маршруты (anonymous → `/login`).
- `AppLayout`: коллапсирующая `Sidebar`, контент через `<Outlet/>`.
- Маршруты: `/phone`, `/meet`, `/transcripts`, `/admin/*`, заглушки `/messengers`, `/contacts`, `/helpdesk` (соответствуют ТЗ 3.2.4).

**Дизайн-система (E4.3):**
- Палитра `C` в `src/styles/tokens.ts` — ровно из переданного UI-прототипа.
- Inline styles (паттерн прототипа); общие шрифты/сброс — `src/styles/globals.css`.
- Заглушки `Empty / Loading / ErrorBox` (`src/components/states.tsx`).

**API client (E4.4):**
- `src/api/client.ts` — типизированный fetch-обёртка с обработкой 401, ApiError.
- `src/api/queryClient.ts` — TanStack Query с разумными дефолтами (staleTime 30s, retry для не-4xx).
- `src/api/me.ts` — пример вызова `/api/v1/me`.
- `npm run gen:api` — генерация типов из `../api/api/openapi.yaml` через `openapi-typescript`.

**WS client (E4.5):**
- `src/ws/wsClient.ts` — нативный WebSocket с экспоненциальным reconnect (1→30s) и subscribe по типу события. Bearer-токен передаётся через subprotocol `bearer.<jwt>` (контракт с `apps/api/internal/ws/handler.go`).
- `src/ws/useWs.ts` — `useWsClient()` + `useWsEvent(type, handler)` для React.

**Auth (E1.9–E1.11 заготовка):**
- `src/auth/AuthContext.tsx` — состояние `loading|anonymous|authenticated`, восстановление через `/oauth/refresh`, `login()`/`logout()`.
- `src/auth/Login.tsx` — экран логина с CTA «Войти через Bitrix24» → редирект на `/oauth/login`.

**i18n (E4.7):**
- Только русский (ТЗ 5.4).
- Все строки в `src/i18n/ru.json`, ключи иерархические.
- Хук: `import { useT } from "@/i18n"` → `useT().t("nav.phone")`.

**E2E (E4.8):**
- `tests/e2e/login.spec.ts` — проверяет, что страница логина рендерится и анонимный заход на защищённый роут редиректит на `/login`.
- `playwright.config.ts` — Chromium / Firefox / WebKit. Run: `npm run e2e` (при запущенном dev-сервере).

## Что не сделано (ждёт прототип)

- **Полный UI Софтфона** (`src/modules/phone/PhonePage.tsx`) — сейчас заглушка. Возьмётся из прототипа `SoftphonePage` (dial pad, состояния звонка, история).
- **Полный UI ВКС** (`src/modules/meet/MeetPage.tsx`) — заглушка. Из прототипа `VcsPage`: список встреч, модалка создания, выбор камеры/микрофона.
- **Полный UI Транскрибации** (`src/modules/transcripts/TranscriptsPage.tsx`) — заглушка. Из прототипа `TranscriptionPage`: загрузка аудио, список с прогрессом, viewer.
- **Полный UI Админки** (`src/modules/admin/AdminPage.tsx`) — заглушка. Из прототипа `Settings*`.
- **NotificationBell, StatusSelector** — компоненты прототипа, нужен полный код.

> Положи полный React-файл в `apps/web/prototype.jsx` или присылай частями — модули будут собраны в продакшен-форму (TypeScript, разнесены по файлам, подключены к React Query и WS-клиенту).

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
