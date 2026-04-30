# ТЗ — Заявки на внутренние номера

**Статус:** черновик, на согласовании
**Связанные документы:** `README.md` (E6 Софтфон), `docs/worklog.md`
**Затронутые модули:** `apps/api/internal/sysset`, `apps/api/internal/ws`, `apps/web/src/softphone`, `apps/web/src/Shell.tsx`

---

## 1. Контекст и цель

После Bitrix-синка все сотрудники появляются в Toolkit, но extension у них не привязан. Сейчас софтфон у непривязанного пользователя показывает форму ручного ввода кредов (dev-fallback) или сообщение «Не настроено», и пользователь не имеет способа сообщить админу, что ему нужен номер.

**Цель:** дать пользователю явный канал «попросить номер», админу — централизованную очередь заявок, обоим — обратную связь без писем/чатов в обход системы.

---

## 1.1. Предусловия работы софтфона у пользователя

Чтобы у пользователя заработал софтфон, администратор должен последовательно выполнить **три шага** (Настройки → Телефония → WebRTC шлюз):

| # | Шаг | Что заполняется | Где хранится |
|---|---|---|---|
| 1 | **Адрес АТС** | `wss_url` (например `wss://pbx.example.com:8089/ws`) | `system_setting/phone_config.wss_url` |
| 2 | **Внутренние номера** | `ext` + SIP-пароль для каждого номера из FreePBX | `system_setting/phone_config.extensions[]` |
| 3 | **Сопоставление user ↔ extension** | `assigned_to = user.id` для каждого номера | то же поле в `extensions[]` |

Только при выполнении всех трёх шагов запрос `GET /api/v1/system-settings/phone/me` возвращает `200` с полным набором кредов `{wss_url, extension, password}`, и `JsSIP` успешно регистрируется на шлюзе.

**Что делает фича «Заявки на внутренние номера»:** закрывает шаг 3 — даёт пользователю явный канал попросить админа сопоставить номер. Заявка может также подтолкнуть админа к выполнению шагов 1-2 (если он ещё их не сделал). Само по себе approve заявки не «включает» софтфон, если шаги 1-2 не пройдены.

**Размещение UI софтфона:** полноценный интерфейс телефона открывается на
отдельном маршруте `https://toolkit.softservice.by/softphone`. На основной
странице `https://toolkit.softservice.by` не показывается встроенный dialer или
floating widget; там остаётся только неоновая иконка телефона. Иконка светится
зелёным, когда пользователь online/registered в телефонии, и красным, когда
софтфон выключен, не зарегистрирован или недоступен. Нажатие на иконку
переводит пользователя на `/softphone`.

**Состояния системы с точки зрения пользователя:**

| `wss_url` | extension с `assigned_to=me` | Что видит пользователь в виджете |
|:---:|:---:|---|
| ❌ | ❌ | CTA «Запросить номер» (создание заявки разрешено — это сигнал админу настроить АТС) |
| ❌ | ✅ | Ошибка «Софтфон в системе не настроен. Обратитесь к администратору» (патологическое состояние, см. §8) |
| ✅ | ❌ | CTA «Запросить номер» |
| ✅ | ✅ | Софтфон регистрируется на FreePBX, нормальный режим работы |

---

## 2. Пользовательские истории

### Сотрудник

**П-1.** Сотрудник без extension'а открывает софтфон → видит CTA **«Запросить внутренний номер»** → нажимает → опционально пишет комментарий («нужен городской», «работаю с клиентами») → отправляет.

**П-2.** Сотрудник с активной заявкой видит в виджете состояние «Заявка отправлена *<дата>*, ожидает одобрения» и кнопку «Отозвать заявку».

**П-3.** Сотрудник, чью заявку одобрили, получает уведомление в Toolkit и в ОС, виджет автоматически переподключается и регистрируется на FreePBX без перезагрузки страницы.

**П-4.** Сотрудник, чью заявку отклонили, видит в виджете причину отказа (если админ её указал) и может создать новую заявку.

### Админ Toolkit

**А-1.** При создании заявки пользователем админ:
- получает push в центр уведомлений Toolkit (NotificationBell);
- если вкладка Toolkit не в фокусе — получает OS-нотификацию;
- видит счётчик-бейдж в табе «Заявки на внутренние номера» (Настройки → Телефония).

**А-2.** Админ заходит в **Настройки → Телефония → Заявки**, видит список pending-заявок (ФИО / отдел / дата / комментарий) и для каждой — две кнопки: «Назначить номер» и «Отклонить».

**А-3.** Админ нажимает «Назначить номер» → диалог с двумя режимами:
- **Свободный из пула** — дропдаун extension'ов из `phone_config.extensions` без `assigned_to`;
- **Новый номер** — поля `ext` + `password` (создаёт extension и сразу привязывает).

После подтверждения заявка → `approved`, в `phone_config.extensions` обновляется `assigned_to`, заявителю уходит WS-уведомление.

**А-4.** Админ нажимает «Отклонить» → опциональный текст причины → заявка → `rejected`.

**А-5.** Админ видит фильтр **Активные** (default, статус pending) / **История** (approved + rejected + cancelled) — для аудита.

---

## 3. Решения по развилкам

| Вопрос | Решение |
|---|---|
| Диалог «Назначить номер» | Совмещённый: дропдаун свободных + переключатель «Создать новый» с полями ext+password |
| Кому уведомление | Всем пользователям с ролью `admin` (online — через WS, offline — увидят при следующем заходе по бейджу в табе) |
| Можно ли пере-отправить после reject | Да — UNIQUE-индекс активной заявки только по `status='pending'` |
| Бейдж счётчика | Только внутри табов Настройки → Телефония, без бейджа в основной NAV |

---

## 4. Модель данных

Новая миграция `000016_phone_extension_requests`:

```sql
CREATE TABLE phone_extension_request (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  status              TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','cancelled')),
  comment             TEXT,                    -- от пользователя при создании
  reject_reason       TEXT,                    -- от админа при отклонении
  assigned_extension  TEXT,                    -- заполняется при approve
  resolved_at         TIMESTAMPTZ,
  resolved_by         UUID REFERENCES "user"(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX phone_extension_request_active_uniq
  ON phone_extension_request(user_id) WHERE status = 'pending';

CREATE INDEX phone_extension_request_status_idx
  ON phone_extension_request(status, created_at DESC);

CREATE TRIGGER phone_extension_request_set_updated_at
  BEFORE UPDATE ON phone_extension_request
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

**Валидации:**
- `comment` — TEXT, длина 0…500 символов, обрезается до 500 на backend.
- `reject_reason` — TEXT, длина 0…500.
- `assigned_extension` — формат: digits, 2…6 символов (та же валидация, что в `PhoneWebrtcTab`).

---

## 5. API

### 5.1. Пользовательские эндпоинты (auth, не admin-only)

| Метод | Путь | Тело | Ответ | Ошибки |
|---|---|---|---|---|
| `GET` | `/api/v1/phone/extension-requests/me` | — | `{request: {…} \| null}` (последняя по `created_at`) | — |
| `POST` | `/api/v1/phone/extension-requests` | `{comment?: string}` | `201 {id, status, created_at}` | `409 already_assigned`; `409 already_pending` |
| `DELETE` | `/api/v1/phone/extension-requests/me` | — | `204` | `404 not_found`; `409 not_pending` |

**Семантика `POST`:**
1. Проверить, есть ли в `phone_config.extensions` запись с `assigned_to = subject.UserID` → если да, `409 already_assigned`.
2. Проверить отсутствие активной заявки (`UNIQUE` индекс гарантирует атомарность; на ошибке вернуть `409 already_pending`).
3. INSERT с `status='pending'`, `comment` обрезается до 500.
4. WS broadcast `phone_extension_request_created` всем admin'ам.

**Семантика `DELETE`:**
1. UPDATE `status='cancelled', resolved_at=NOW()` WHERE `user_id=me AND status='pending'`. Если 0 строк — `404`/`409`.
2. WS broadcast `phone_extension_request_cancelled` всем admin'ам.

### 5.2. Админские эндпоинты (`RequireRole(admin)`)

| Метод | Путь | Параметры | Тело | Ответ |
|---|---|---|---|---|
| `GET` | `/api/v1/admin/phone/extension-requests` | `?status=pending\|history&limit=50&offset=0` | — | `{items: […], total: N, pending_count: M}` |
| `POST` | `/api/v1/admin/phone/extension-requests/{id}/approve` | — | `{ext: string, password?: string}` | `200 {…request, assigned_extension}` |
| `POST` | `/api/v1/admin/phone/extension-requests/{id}/reject` | — | `{reason?: string}` | `200 {…request, reject_reason}` |

`pending_count` возвращается всегда — фронт берёт его для бейджа на табе.

**Item shape:**
```json
{
  "id": "uuid",
  "user": {
    "id": "uuid",
    "full_name": "Иванов Иван",
    "email": "ivanov@company.local",
    "department": "Отдел продаж",
    "position": "Менеджер"
  },
  "status": "pending",
  "comment": "нужен городской",
  "reject_reason": null,
  "assigned_extension": null,
  "resolved_at": null,
  "resolved_by": null,
  "resolved_by_name": null,
  "created_at": "2026-04-27T10:00:00Z"
}
```

**Семантика `approve`:**

В одной транзакции:
1. `SELECT FOR UPDATE` строки заявки. Если `status != 'pending'` → `409 not_pending`.
2. Проверить `user.status='active'` (заявитель не деактивирован) → иначе `409 user_inactive`.
3. Read-modify-write `system_setting/phone_config` (advisory lock на key, чтобы не было гонок с PUT phone-config из админки):
   - Если `ext` уже есть в `extensions[]`:
     - если `assigned_to != null` и `assigned_to != request.user_id` → `409 ext_already_assigned`;
     - если `password` пустой — оставить старый;
     - ставим `assigned_to = request.user_id`.
   - Если `ext` новый — добавляем `{ext, password, assigned_to}`. `password` обязателен в этом случае → иначе `400 password_required`.
4. UPDATE заявки: `status='approved'`, `assigned_extension=ext`, `resolved_at=NOW()`, `resolved_by=admin.user_id`.
5. COMMIT.
6. WS publish `phone_extension_request_resolved` → user_id заявителя.

**Семантика `reject`:**
1. `UPDATE WHERE id=$1 AND status='pending'` → `status='rejected'`, `reject_reason=$2`, `resolved_at=NOW()`, `resolved_by=admin.user_id`.
2. Если 0 строк → `409 not_pending`.
3. WS publish `phone_extension_request_resolved` → user_id заявителя.

### 5.3. Формат ошибок

Стандартный формат проекта:
```json
{ "code": "ext_already_assigned", "message": "Этот номер уже назначен другому пользователю" }
```

Коды ошибок (полный список):
- `400 password_required` — создаётся новый extension без пароля.
- `400 invalid_ext` — формат extension не подходит.
- `404 not_found` — заявка не найдена.
- `409 already_assigned` — у пользователя уже есть extension.
- `409 already_pending` — у пользователя уже активная заявка.
- `409 not_pending` — заявка не в статусе pending (резолвлена кем-то параллельно).
- `409 ext_already_assigned` — выбранный ext уже занят другим пользователем.
- `409 user_inactive` — заявитель деактивирован.

---

## 6. WebSocket-события

В `internal/ws/hub.go` сейчас только per-user подписки. **Расширение:** добавить per-role подписку.

```go
// Hub.PublishToRole рассылает event всем online-подключениям пользователей
// с указанной ролью. Реализуется через индекс role -> []*conn в hub.
func (h *Hub) PublishToRole(role string, event any) { ... }
```

При подключении к WS клиент передаёт subject (уже есть) — hub индексирует подключение и по `subject.UserID`, и по `subject.Role`.

### 6.1. Типы событий

| Тип | Получатели | Payload |
|---|---|---|
| `phone_extension_request_created` | все online admin'ы | `{request_id, user: {id, full_name, department}, comment, created_at}` |
| `phone_extension_request_cancelled` | все online admin'ы | `{request_id}` |
| `phone_extension_request_resolved` | заявитель (`user_id` из заявки) | `{request_id, status: "approved"\|"rejected", assigned_extension?, reject_reason?}` |

### 6.2. Доставка offline-админам

**Гарантий нет.** Если админ оффлайн в момент создания заявки — он увидит её при следующем заходе на страницу заявок (запрос `GET /admin/phone/extension-requests` с фильтром pending всё покажет). Бейдж счётчика обновится из `pending_count` в ответе того же запроса при открытии Настроек → Телефония.

---

## 7. UI

### 7.1. Виджет софтфона

В `SoftphoneWidget` ([Shell.tsx:531-745](toolkit/apps/web/src/Shell.tsx#L531-L745)) состояние `not_configured` сейчас рендерит `<SoftphoneConfigForm>`. Меняем логику:

```
useMyPhoneCredentials() → creds, credsLoading
useMyExtensionRequest()  → request, requestLoading

if (credsLoading) → spinner

if (creds && creds.wss_url && creds.extension) →
  JsSIP.start()  // нормальный режим (шаги 1-3 пройдены)

else if (creds && creds.extension && !creds.wss_url) →
  // патологическое состояние: extension назначен, но WSS не настроен
  Card: "Софтфон в системе не настроен"
  Описание: "Внутренний номер закреплён за вами, но администратор ещё не указал
            адрес АТС. Обратитесь к администратору Toolkit."
  (без CTA — заявка на номер бессмысленна, номер уже есть)

else if (devOverride from window.__TOOLKIT_PHONE__ or sessionStorage) →
  JsSIP.start()  // dev-escape, не трогаем

else if (request?.status === "pending") →
  Card: "Заявка отправлена <date>, ожидает одобрения админа"
  Button: "Отозвать заявку"

else if (request?.status === "rejected") →
  Card: "Заявка отклонена <date>"
  Если reject_reason — показываем причину
  Button: "Запросить ещё раз"

else (нет заявок или approved-исторические) →
  Заголовок: "Внутренний номер не назначен"
  Описание: "Запросите номер у администратора Toolkit"
  Textarea (опц.): "Комментарий (необязательно)"  -- 500 chars max
  Button: "Запросить номер"
```

**Важно:** условие первой ветки — `creds.wss_url && creds.extension` (оба непустые). Это защищает от ситуации, когда админ approve'нул заявку, но забыл заполнить `wss_url` — JsSIP в этом случае не пытается стартовать с битыми кредами.

WS-обработчик `phone_extension_request_resolved` в виджете:
- `status='approved'` → `qc.invalidateQueries(["my-phone-credentials"])` → виджет автоматически переходит в connecting/registered + push-нотификация «Внутренний номер назначен: <ext>»;
- `status='rejected'` → `qc.invalidateQueries(["my-extension-request"])` → виджет показывает причину отказа + push «Заявка отклонена».

### 7.2. Админ — новая вкладка в Настройки → Телефония

В `PhoneSettingsPage` ([Shell.tsx:2305-2338](toolkit/apps/web/src/Shell.tsx#L2305-L2338)) добавить третий таб:

```ts
{ id: "requests", label: "Заявки на внутренние номера", Icon: Inbox }
```

С бейджем `pendingCount`, если > 0 — справа от label маленький круглый счётчик красного цвета.

**Содержимое таба `PhoneRequestsTab`:**

1. **Шапка:** счётчик активных + переключатель «Активные / История» (segmented control).
2. **Список заявок** — карточки:
   - аватар (инициалы) + ФИО + email + отдел + должность;
   - дата подачи (relative + absolute в title);
   - комментарий пользователя (если есть, в кавычках курсивом);
   - для pending: кнопки «Назначить номер» / «Отклонить»;
   - для resolved: бейдж статуса + дата резолва + кто резолвил + (для approved) присвоенный ext, (для rejected) причина отказа.
3. **Пустое состояние:** «Активных заявок нет» / «История пуста».

**Диалог «Назначить номер»** (модальное окно):
- Заголовок: «Назначить номер: <ФИО заявителя>».
- **Warning-баннер**, если `phone_config.wss_url` пустой:
  «Адрес АТС (WSS) не указан в табе «WebRTC шлюз». После назначения номера софтфон у пользователя не заработает, пока вы не заполните WSS-адрес.»
  (баннер только информационный, не блокирует approve.)
- Радио-переключатель:
  - **Из свободных номеров** (default если есть свободные):
    `<select>` с extension'ами без `assigned_to`. Если свободных нет — radio disabled с подсказкой «Свободных номеров нет».
  - **Создать новый номер**:
    Поле `ext` (digits, 2-6) + поле `password` (обязательно).
- Кнопки: «Отмена» / «Назначить».
- Обработка ошибок API (`409 ext_already_assigned`, `400 password_required`) — inline над кнопками.

**Диалог «Отклонить»** (модальное окно):
- Заголовок: «Отклонить заявку: <ФИО заявителя>».
- Textarea: «Причина (необязательно)» — 500 chars max, счётчик символов.
- Кнопки: «Отмена» / «Отклонить» (красная).

### 7.3. Уведомления админу

В корневом компоненте `Shell.tsx` (или отдельном `useAdminNotifications`) подписаться на WS только для admin-роли:

```ts
useWsEvent("phone_extension_request_created", (payload) => {
  if (me.role !== "admin") return;  // на всякий случай
  push({
    type: "system",
    title: "Запрос на внутренний номер",
    desc: `${payload.user.full_name} (${payload.user.department}) запросил номер`,
    onClick: () => navigate("/settings/phone?tab=requests"),
  });
  qc.invalidateQueries(["admin-extension-requests"]);
});

useWsEvent("phone_extension_request_cancelled", () => {
  qc.invalidateQueries(["admin-extension-requests"]);
});
```

`push()` уже дублирует в OS notification center, когда `document.hidden === true`. Иконка — наш logo.

Аналогично для пользователя:

```ts
useWsEvent("phone_extension_request_resolved", (payload) => {
  if (payload.status === "approved") {
    push({ type: "call", title: "Внутренний номер назначен",
           desc: `Ваш номер: ${payload.assigned_extension}` });
    qc.invalidateQueries(["my-phone-credentials"]);
  } else {
    push({ type: "system", title: "Заявка на номер отклонена",
           desc: payload.reject_reason || "Без указания причины" });
  }
  qc.invalidateQueries(["my-extension-request"]);
});
```

---

## 8. Граничные случаи

| Сценарий | Поведение |
|---|---|
| У пользователя уже есть extension | Кнопка «Запросить номер» не показывается; POST `/extension-requests` → `409 already_assigned`. |
| Админ удаляет extension во время того, как он назначен | `/phone/me` → 404 → виджет уходит в `not_configured` → CTA «Запросить номер» снова. Связанная approved-заявка остаётся в истории. |
| Админ снимает `assigned_to` (отвязал номер) | То же — `/phone/me` 404, юзер может подать новую заявку. |
| Заявитель деактивирован (Bitrix sync soft-deactivate) | Заявка остаётся видимой админу, при approve → `409 user_inactive`. UI скрывает кнопку «Назначить» и показывает badge «деактивирован». |
| Параллельный approve двумя админами одной заявки | `UPDATE WHERE status='pending'` гарантирует, что второй admin получит `409 not_pending`. UI обновляет список. |
| Параллельное назначение одного ext двум разным заявкам | Транзакция с проверкой `assigned_to IS NULL` + advisory lock на phone_config. Второй админ → `409 ext_already_assigned`. |
| Пользователь отозвал заявку, пока админ открыл диалог approve | На approve приходит `409 not_pending`, UI показывает уведомление «Заявка уже отозвана» и обновляет список. |
| Админ создаёт extension с уже существующим ext'ом в режиме «Создать новый» | Логика та же, что в режиме «из свободных» — обновляется `assigned_to`. Если ext занят — `409 ext_already_assigned`. |
| Заявитель удалён из таблицы `user` | ON DELETE CASCADE — заявки удалятся вместе. (Но в практике пользователи не удаляются, только soft-deactivate.) |
| Админ approve'нул заявку, но `wss_url` в phone_config пустой | Approve проходит (заявка → `approved`, `assigned_to` ставится), но виджет пользователя показывает «Софтфон в системе не настроен», JsSIP не стартует. В диалоге approve админ видит warning-баннер заранее (§7.2). |
| Админ удалил `wss_url` (очистил поле) при существующих привязках | У всех пользователей с привязанными extension'ами виджет переходит в состояние «Софтфон в системе не настроен» до восстановления WSS. Заявки на номер от них не нужны (extension уже есть). |
| Заявка создана раньше, чем админ настроил WSS | Это нормальный сценарий: пользователь жмёт «Запросить номер» при пустой системе → админ видит заявку, идёт настраивать (WSS → extensions → approve). Заявки сами «подсказывают», что АТС нужно поднять. |

---

## 9. Не входит в эту задачу

- **Email-уведомление админу** о заявке (можно потом, поверх существующего mailer'а).
- **Email-уведомление пользователю** при approve/reject.
- **Аудит-лог в `audit_log`** для approve/reject — добавим отдельной задачей в эпике GDPR/audit-log UI.
- **Авто-генерация extension на стороне FreePBX** при approve (требует FreePBX REST/CLI интеграции — отдельная задача).
- **«Запросить смену номера»** для пользователей с уже привязанным extension.
- **Заявка с предпочтительным префиксом/типом номера** (городской/мобильный) — пока только свободный текст в `comment`.
- **Назначение номера сразу нескольким пользователям** (shared extension) — модель «один user — один ext» сохраняется.

---

## 10. Объём работ

| Слой | Что меняется |
|---|---|
| Миграции | +1 миграция `000016_phone_extension_requests` |
| Backend Go | новый пакет `internal/phonereq` + 6 эндпоинтов + расширение `ws/hub.go` (per-role broadcast) + регистрация роутов в `server/server.go` |
| Frontend | новые хуки в `api/phone-requests.ts`; правки в `SoftphoneWidget`; новый компонент `PhoneRequestsTab`; третий таб в `PhoneSettingsPage`; глобальные WS-обработчики в `Shell.tsx` |
| OpenAPI | обновить `apps/api/api/openapi.yaml` |
| Документация | запись в `docs/worklog.md` после релиза |

---

## 11. Открытые вопросы

*(пусто — все основные развилки закрыты в §3)*

---

## 12. Чек-лист приёмки

- [ ] Пользователь без extension видит кнопку «Запросить номер» в софтфоне.
- [ ] После клика заявка попадает в БД, видна админу в новом табе, админ получает push в Toolkit и OS-нотификацию (если вкладка не в фокусе).
- [ ] Админ может одобрить заявку, выбрав свободный номер ИЛИ создав новый — в обоих случаях `phone_config` обновляется и пользователь получает регистрацию в SIP без перезагрузки страницы.
- [ ] Админ может отклонить заявку с причиной — пользователь видит причину в виджете.
- [ ] Пользователь может отозвать активную заявку.
- [ ] Пользователь после rejected может подать новую заявку.
- [ ] Бейдж pending-счётчика виден на табе «Заявки» и обновляется в реальном времени по WS.
- [ ] Параллельные approve/reject двумя админами не приводят к рассинхрону (один из admin'ов получает 409, UI корректно обрабатывает).
- [ ] Удаление extension/снятие assigned_to возвращает пользователя к CTA «Запросить номер».
