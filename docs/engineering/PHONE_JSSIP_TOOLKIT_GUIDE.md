# Toolkit JsSIP Softphone Guide

Практический гайд по телефонии Toolkit: как устроен текущий браузерный софтфон на JsSIP и как развивать вторую PWA-звонилку `/softphone2`.

## Цель

Документ нужен разработчику, который переносит логику из `crm-main` в Toolkit или дорабатывает Toolkit-телефон без раздвоения SIP-движка.

В Toolkit уже есть:

- React 18 + Vite SPA.
- JsSIP-клиент в `apps/web/src/softphone/useSoftphone.ts`.
- API для кредов текущего пользователя: `GET /api/v1/system-settings/phone/me`.
- Админские настройки телефонии: `GET/PUT /api/v1/admin/system-settings/phone`.
- Маршрут `/softphone`.

Вторая звонилка `/softphone2` должна использовать тот же SIP-хук, но иметь отдельный PWA-friendly интерфейс.

## Архитектура

```text
apps/web/src/App.tsx
  /softphone   -> SoftphonePage
  /softphone2  -> Softphone2Page
  остальные    -> Shell

apps/web/src/softphone/useSoftphone.ts
  JsSIP UA
  RTCSession
  состояния регистрации и звонка
  remote audio
  dial / answer / hangup / mute / hold / DTMF

apps/web/src/api/system-settings.ts
  useMyPhoneCredentials()
  usePhoneConfig()
  useUpdatePhoneConfig()

apps/web/public/
  manifest.webmanifest
  manifest-softphone2.webmanifest
  sw.js
  pwa-icon.svg
```

Важное правило: `useSoftphone` остаётся единственным местом, которое напрямую работает с `JsSIP.UA` и `RTCSession`. UI-страницы только вызывают методы хука.

## Backend Контракты

### Креды пользователя

`GET /api/v1/system-settings/phone/me`

Ответ при назначенном extension:

```json
{
  "wss_url": "wss://pbx.example.com:8089/ws",
  "extension": "101",
  "password": "secret"
}
```

Ответ `404` означает штатное состояние: пользователю не назначен внутренний номер.

UI должен:

- показывать экран "номер не назначен";
- не запускать JsSIP;
- не падать и не ретраить бесконечно.

### Админские настройки

`GET /api/v1/admin/system-settings/phone`

```json
{
  "wss_url": "wss://pbx.example.com:8089/ws",
  "extensions": [
    {
      "ext": "101",
      "has_password": true,
      "assigned_to": "user-id"
    }
  ]
}
```

`PUT /api/v1/admin/system-settings/phone`

```json
{
  "wss_url": "wss://pbx.example.com:8089/ws",
  "extensions": [
    {
      "ext": "101",
      "password": "secret",
      "assigned_to": "user-id"
    }
  ]
}
```

Пароль возвращается только текущему владельцу extension через `/phone/me`.

## Состояния `useSoftphone`

```ts
type SoftphoneState =
  | { kind: "not_configured" }
  | { kind: "connecting" }
  | { kind: "registered" }
  | { kind: "registration_failed"; cause: string }
  | { kind: "incoming"; from: string; sessionId: string }
  | { kind: "outgoing"; to: string; sessionId: string }
  | { kind: "active"; peer: string; sessionId: string; startedAt: number; muted: boolean; held: boolean }
  | { kind: "ended"; reason: string };
```

UI-маппинг:

```text
not_configured        -> нет назначенного номера или пустой wss_url
connecting            -> JsSIP стартует и регистрируется
registered            -> можно звонить
registration_failed   -> ошибка регистрации, показать причину и retry
incoming              -> входящий экран
outgoing              -> экран набора/вызова
active                -> активный разговор
ended                 -> короткий экран завершения, затем возврат в registered
```

## Старт Регистрации

Страница телефона должна:

1. Вызвать `useMyPhoneCredentials()`.
2. Дождаться завершения загрузки.
3. Если `wss_url` или `extension` пустые, вызвать `phone.stop()`.
4. Если креды есть, собрать `SoftphoneConfig`.
5. Запускать `phone.start(cfg)` только при изменении ключа `wssUrl|extension|password`.

```ts
const key = `${cfg.wssUrl}|${cfg.extension}|${cfg.password}`;
if (startedKeyRef.current !== key) {
  startedKeyRef.current = key;
  phone.start(cfg);
}
```

Это защищает от повторного старта UA на каждом render.

## Исходящий Звонок

UI должен разрешать кнопку звонка только когда:

```ts
state.kind === "registered" && number.trim() !== ""
```

Для набора:

```ts
phone.dial(number.trim());
```

Текущий `useSoftphone` передаёт номер в `ua.call(...)`. Если FreePBX требует SIP URI, расширение хука должно нормализовать номер в формат:

```ts
`sip:${number}@${domain}`
```

## Входящий Звонок

`useSoftphone` слушает `ua.on("newRTCSession")`.

Для входящего звонка:

- состояние становится `incoming`;
- UI показывает номер;
- можно вызвать `phone.answer()` или `phone.hangup()`;
- ringtone и уведомления остаются ответственностью UI-слоя.

## Активный Разговор

Для `active` UI должен показывать:

- номер собеседника;
- таймер от `startedAt`;
- mute;
- hold;
- DTMF-клавиатуру;
- hangup.

Методы:

```ts
phone.toggleMute();
phone.toggleHold();
phone.sendDtmf("5");
phone.hangup();
```

## PWA Для `/softphone2`

У Toolkit есть общий service worker `apps/web/public/sw.js`. Для второй звонилки нужен отдельный manifest:

```text
apps/web/public/manifest-softphone2.webmanifest
```

Минимальные настройки:

```json
{
  "name": "Toolkit Softphone 2",
  "short_name": "Softphone 2",
  "start_url": "/softphone2",
  "scope": "/",
  "display": "standalone",
  "orientation": "portrait"
}
```

На странице `/softphone2` можно заменить `<link rel="manifest">` на `/manifest-softphone2.webmanifest`, чтобы установка PWA открывала именно вторую звонилку.

Service worker должен кешировать:

- `/softphone`;
- `/softphone2`;
- `/manifest.webmanifest`;
- `/manifest-softphone2.webmanifest`;
- `/pwa-icon.svg`.

API-запросы, OAuth и RTC/WebRTC-прокси кешировать нельзя.

## Интерфейс `/softphone2`

Рекомендуемый состав:

- Верхняя панель: название, extension, SIP-статус, PWA/install action.
- Основной экран:
  - idle/registered: поле номера и keypad;
  - connecting/outgoing: номер и кнопка завершения;
  - incoming: входящий экран с answer/reject;
  - active: таймер, mute, hold, DTMF, hangup;
  - failed: причина ошибки и retry.
- Нижняя область: краткая история последних звонков из localStorage.

История в `/softphone2` может быть локальной PWA-историей. Серверный `CallLog` в Toolkit пока не является обязательным контрактом для JsSIP-клиента.

## Ограничения По Сравнению С `crm-main`

В `crm-main` есть DND, BLF, transfer, Bitrix `telephony.externalcall.register/finish`, hold music и attended transfer. В текущем Toolkit-хуке уже есть базовая телефония:

- регистрация;
- входящие;
- исходящие;
- remote audio;
- mute;
- hold;
- DTMF.

Чтобы получить полный parity с `crm-main`, отдельно добавить:

1. DND API и состояние в `useSoftphone`.
2. `/api/v1/phone/call-register` и `/api/v1/phone/call-finish`.
3. Нормализацию SIP URI для исходящих.
4. Transfer через `session.refer(...)`.
5. BLF `SUBSCRIBE dialog`.
6. Подмену аудиотрека для приветствия/музыки удержания.

## Проверка

Минимальный тест с реальной FreePBX-линейкой:

1. Пользователь без extension открывает `/softphone2` и видит "номер не назначен".
2. Админ назначает extension и WSS URL.
3. Пользователь открывает `/softphone2`, статус становится "Готов".
4. Исходящий звонок проходит до второго extension.
5. Входящий звонок показывает full-screen incoming UI.
6. Answer включает remote audio.
7. Mute и hold меняют состояние на UI и в SIP-сессии.
8. DTMF отправляет тон в активной сессии.
9. Hangup завершает сессию и пишет локальную историю.
10. Установка PWA открывает `/softphone2` в standalone-режиме.
