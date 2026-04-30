# ТЗ: исходящий звонок, early media и локальный гудок в Toolkit

## Цель

Реализовать в Toolkit предсказуемый аудио-поток исходящего звонка по модели `crm-main`:

```text
click call
  -> doCall()
  -> useSoftphone.call()
  -> JsSIP ua.call()
  -> callStatus = connecting
  -> attachAudio(session)
  -> SIP progress
  -> callStatus = ringing
  -> UI показывает "Вызов…"
  -> если FreePBX прислал early media, слышен гудок от АТС
  -> если early media нет, играет локальный synthetic ringback
  -> SIP confirmed
  -> callStatus = active
  -> короткий beep "клиент взял трубку"
  -> timer + call-register
```

Главная проблема: сейчас при исходящем звонке пользователь может слышать тишину до ответа клиента, если FreePBX не отдаёт early media. Нужно добавить локальный fallback-гудок, но не ломать early media от АТС.

## Область Работ

Входит:

- исходящий звонок в `apps/web/src/softphone/useSoftphone.ts`;
- UI `/softphone` и `/softphone2`;
- локальный ringback fallback через Web Audio API;
- короткий beep при переходе исходящего звонка в `active`;
- понятные статусы `connecting` / `ringing` / `active`;
- базовый call-register/call-finish контракт как следующий шаг, если backend готов.

Не входит:

- DND;
- BLF;
- transfer;
- hold music;
- запись разговоров;
- Bitrix24 `telephony.externalcall.*`, если для Toolkit backend ещё не готов.

## Текущая Логика Toolkit

Текущий `useSoftphone` уже делает:

- `JsSIP.UA`;
- `ua.call(...)`;
- `newRTCSession`;
- `incoming/outgoing/active/ended`;
- remote audio через `RTCPeerConnection.track`;
- `answer`;
- `hangup`;
- `mute`;
- `hold`;
- `sendDTMF`.

Пробелы:

- нет отдельного состояния `ringing`;
- `progress` только логируется;
- нет локального ringback fallback;
- нет beep при ответе клиента;
- исходящий номер может передаваться как raw number, а не SIP URI;
- нет call-register/call-finish для серверного лога звонков.

## Требуемые Состояния

Расширить `SoftphoneState`:

```ts
export type SoftphoneState =
  | { kind: "not_configured" }
  | { kind: "connecting" }
  | { kind: "registered" }
  | { kind: "registration_failed"; cause: string }
  | { kind: "incoming"; from: string; sessionId: string }
  | { kind: "outgoing"; to: string; sessionId: string }
  | { kind: "ringing"; to: string; sessionId: string; earlyMedia: boolean }
  | { kind: "active"; peer: string; sessionId: string; startedAt: number; muted: boolean; held: boolean; direction: "incoming" | "outgoing" }
  | { kind: "ended"; reason: string };
```

Если менять тип слишком рискованно, допустим минимальный вариант:

- оставить `outgoing`;
- добавить внутренний ref `outgoingPhaseRef: "connecting" | "ringing"`;
- UI всё равно должен отличать `connecting` от `ringing`.

Предпочтительный вариант: явный `kind: "ringing"`.

## Исходящий Звонок

### Вызов Из UI

UI вызывает:

```ts
phone.dial(number.trim())
```

Кнопка звонка активна только если:

```ts
phone.state.kind === "registered" && number.trim() !== ""
```

### Нормализация Номера

В `useSoftphone` добавить helper:

```ts
function sipTarget(to: string, cfg: SoftphoneConfig): string {
  if (/^sip:/i.test(to)) return to;
  const domain = cfg.domain || hostFromWss(cfg.wssUrl);
  return `sip:${to}@${domain}`;
}
```

`ua.call()` должен получать SIP URI:

```ts
uaRef.current.call(sipTarget(to, cfgRef.current), ...)
```

Для этого сохранить актуальный config в `cfgRef`.

## JsSIP Events

### После `ua.call`

Сразу после создания session:

```ts
sessionRef.current = session;
setState({ kind: "outgoing", to, sessionId: session.id });
attachAudio(session);
startLocalRingback("connecting");
```

`startLocalRingback("connecting")` может играть тихий короткий тон или ждать `progress`. Предпочтительно начинать ringback только после `progress`, чтобы не играть гудок при мгновенной ошибке INVITE.

### `progress`

На `session.on("progress")`:

```ts
setState({ kind: "ringing", to, sessionId: session.id, earlyMedia: hasRemoteAudioRef.current });
startLocalRingback("ringing");
```

Если на этот момент уже пришёл remote audio track от АТС, локальный ringback не нужен.

### Remote Audio / Early Media

В `attachAudio(session)` при событии `track`:

```ts
hasRemoteAudioRef.current = true;
stopLocalRingback();
audioRef.current.srcObject = ev.streams[0];
void audioRef.current.play().catch(...);
```

Это ключевое правило:

- FreePBX прислал early media → слушаем АТС;
- early media нет → играет локальный fallback.

### `accepted` / `confirmed`

При ответе клиента:

```ts
stopLocalRingback();
playAnsweredBeep();
setState({
  kind: "active",
  peer,
  sessionId: session.id,
  startedAt: Date.now(),
  muted: false,
  held: false,
  direction: "outgoing",
});
```

В `crm-main` timer начинается на `confirmed`. В Toolkit можно использовать текущий `accepted`, но лучше унифицировать:

- `accepted`: можно обновить UI, если нужно;
- `confirmed`: считать звонок реально активным и запускать timer.

Выбрать один источник истины, чтобы не было двойного перехода в `active`.

### `failed` / `ended`

На любом завершении:

```ts
stopLocalRingback();
stopAnsweredBeep();
teardownSession();
setState({ kind: "ended", reason });
```

Через 2 секунды вернуть `registered`, если UA всё ещё зарегистрирован.

## Локальный Ringback Fallback

Добавить в `apps/web/src/components/softphone/audio.ts` или новый файл `apps/web/src/softphone/callAudio.ts`.

API:

```ts
export function startOutgoingRingback(): void;
export function stopOutgoingRingback(): void;
export function playAnsweredBeep(): void;
```

### Поведение

`startOutgoingRingback()`:

- безопасно no-op, если уже играет;
- создаёт `AudioContext`;
- играет повторяющийся тон дозвона;
- не использует mp3-файл;
- должен работать после первого user gesture, как текущие DTMF/ringtone.

Рекомендуемый паттерн:

```text
425 Hz tone 1.0s
pause 3.0s
repeat
```

Это ближе к классическому ringback, чем мелодия входящего.

`stopOutgoingRingback()` вызывается при:

- remote audio track;
- active/confirmed;
- failed;
- ended;
- hangup;
- unmount.

## Beep При Ответе Клиента

Сделать как в `crm-main`: три коротких тона.

```ts
playBeep(880, now, 0.12)
playBeep(1100, now + 0.15, 0.12)
playBeep(1320, now + 0.30, 0.20)
```

Условия:

- играть только для `direction === "outgoing"`;
- играть только один раз на звонок;
- не играть для входящих;
- не играть, если звонок завершился до `active`.

## UI Требования

### `/softphone`

Обновить маппинг состояния:

```ts
case "outgoing":
  return { kind: "dialing", label: "Соединение…" };
case "ringing":
  return { kind: "dialing", label: "Вызов…" };
```

Если текущий UI `CallState` не содержит `label`, добавить локальную функцию в странице или расширить тип аккуратно.

### `/softphone2`

В active stage:

- `outgoing` → `Соединение`;
- `ringing` → `Вызов`;
- `active` → таймер.

Если `ringing.earlyMedia === true`, UI можно показать маленькую подпись `гудок от АТС`. Это необязательно, но полезно для отладки.

## Call Register / Timer

Если backend call-log готов:

### При `confirmed`

Вызвать:

```ts
POST /api/v1/phone/call-register
{
  "phone_number": "<number>",
  "direction": "outgoing"
}
```

Сохранить `callLogIdRef`.

### При `ended` / `failed`

Вызвать:

```ts
POST /api/v1/phone/call-finish
{
  "call_log_id": "<id>",
  "duration": 42,
  "disposition": "ANSWERED" | "NO_ANSWER" | "FAILED" | "REJECTED"
}
```

Если backend ещё не готов, оставить локальную историю `/softphone2` как сейчас.

## Логирование Для Отладки

При включённом `?jssip_debug=1` логировать:

- `dial`;
- `session progress`;
- `remote track`;
- `ringback start`;
- `ringback stop: early_media`;
- `ringback stop: active`;
- `answered beep`;
- `session failed`;
- `session ended`.

Пример:

```ts
softphoneLog("ringback start", { sessionId: s.id });
softphoneLog("ringback stop", { reason: "early_media" });
```

## Acceptance Criteria

1. При исходящем звонке UI сразу показывает `Соединение…`.
2. При SIP `progress` UI показывает `Вызов…`.
3. Если FreePBX присылает early media, слышен звук от АТС, локальный ringback прекращается.
4. Если early media не приходит, пользователь слышит локальный ringback fallback.
5. При ответе клиента локальный ringback останавливается.
6. При ответе клиента один раз играет короткий beep.
7. После ответа стартует timer.
8. При `hangup`, `failed`, `ended` все локальные звуки останавливаются.
9. Входящий ringtone не меняется.
10. DTMF, mute, hold продолжают работать.
11. Повторный исходящий звонок после завершения не наследует старый ringback/audio refs.
12. Если браузер заблокировал AudioContext до первого gesture, звонок не ломается; после первого gesture звук работает.

## Тест-План

### Сценарий A: FreePBX отдаёт early media

1. Открыть `/softphone2?jssip_debug=1`.
2. Позвонить на внешний номер.
3. Дождаться `progress`.
4. Убедиться, что слышен гудок АТС.
5. В логах увидеть `remote track` и `ringback stop: early_media`.
6. При ответе услышать короткий beep.

### Сценарий B: FreePBX не отдаёт early media

1. Отключить/обойти early media на тестовом маршруте или позвонить на направление без media до ответа.
2. Позвонить.
3. После `progress` должен играть локальный ringback.
4. При `confirmed` ringback должен остановиться.
5. Должен прозвучать beep.

### Сценарий C: Недозвон

1. Позвонить на номер, который не отвечает.
2. Дождаться `ringing`.
3. Нажать hangup.
4. Ringback должен остановиться сразу.
5. UI должен вернуться в `registered`.

### Сценарий D: Ошибка

1. Позвонить на неправильный номер.
2. Получить `failed`.
3. Ringback должен остановиться.
4. UI показывает причину завершения.

## Риски

- Если одновременно играть local ringback и early media, будет двойной гудок. Поэтому `track` обязан останавливать local ringback.
- `AudioContext` может быть suspended без user gesture. Нужно использовать текущий unlock-паттерн из softphone UI.
- `progress` может приходить без media. Это нормальный случай, для него и нужен fallback.
- `accepted` и `confirmed` могут оба приходить в одной сессии. Нужен guard, чтобы beep/timer не стартовали дважды.

## Минимальный План Реализации

1. Добавить `ringing` в `SoftphoneState`.
2. Добавить `cfgRef`, `hasRemoteAudioRef`, `answeredBeepPlayedRef`.
3. Добавить `startOutgoingRingback`, `stopOutgoingRingback`, `playAnsweredBeep`.
4. В `dial()` нормализовать номер в SIP URI.
5. На `progress` ставить `ringing` и запускать fallback.
6. В `attachAudio` останавливать fallback при remote track.
7. На `confirmed` ставить `active`, останавливать fallback, играть beep, запускать timer.
8. На `ended/failed/hangup/stop/unmount` чистить все audio refs.
9. Обновить `/softphone` и `/softphone2` под `ringing`.
10. Прогнать ручные тесты с реальной FreePBX-линейкой.
