# Toolkit — runbook развёртывания

Шаблон для DevOps/админа: первичный деплой и эксплуатация Toolkit в корпоративной сети.

Связанные документы (поставляются вне публичного репо):
- ТЗ MVP — функциональные и нефункциональные требования.
- Архитектурный документ — компоненты, потоки, модель данных.
- `README.md` — публичное описание продукта.

---

## Плейсхолдеры

Перед запуском подставьте эти значения по всему документу (`sed -i`, `Find&Replace`
или вручную). Все примеры написаны через них, чтобы упростить адаптацию.

| Плейсхолдер | Пример | Назначение |
|---|---|---|
| `<APP_SERVER>` | `10.0.5.42` | Внутренний IP сервера, где крутится docker compose стек |
| `<APP_BIND_PORT>` | `18001` | Порт, на котором web-контейнер виден reverse-proxy (`APP_BIND_PORT` в `.env`, не публикуется в Internet) |
| `<PROXY_HOST>` | `proxy.company.local` | Хост reverse-proxy (Nginx Proxy Manager, HAProxy и т.п.); часто совпадает с edge-сервером |
| `<TOOLKIT_DOMAIN>` | `toolkit.example.com` | Публичный домен для SPA / REST API / WebSocket-сигналинга LiveKit |
| `<LIVEKIT_DOMAIN>` | `lk.example.com` | Публичный домен для `wss://` сигналинга LiveKit (отдельный proxy-host с включённым WebSockets Support) |
| `<TURN_DOMAIN>` | `turn.example.com` | DNS-имя coturn для STUN/TURN; `realm` в conf coturn должен совпадать |
| `<PUBLIC_IP>` | `198.51.100.20` | Публичный IP для DNAT (часто = WAN-адрес border-router) |

---

## 1. Топология

```
            публичный IP (граничное оборудование)
                 │
        DNAT 443/TCP        DNAT 3478 + 50000-60000/UDP
                 ▼                    ▼
   ┌──────────────────────┐   ┌──────────────────────┐
   │ Reverse-proxy        │   │  app-server          │
   │ <PROXY_HOST>         │   │  <APP_SERVER>        │
   │ TLS termination      │   │  /opt/toolkit        │
   │ Let's Encrypt        │   │  docker compose      │
   │                      │   │  + LiveKit (host net)│
   └──────────┬───────────┘   │  + coturn (host net) │
              │ HTTP/WSS      └──────────┬───────────┘
              │ allowlist по IP          │ UDP media напрямую
              ▼                          ▼
        web:18001 ─── nginx ──── api:8080
                                  worker
                                  postgres + minio + opensearch + redis
                                  prometheus + grafana + loki + promtail
                                  node-exporter + postgres-exporter
                                  postgres-backup
```

DNS (силами команды домена):
- `<TOOLKIT_DOMAIN>` → публичный IP, DNAT 443/TCP → `<PROXY_HOST>:443` (внешний reverse-proxy).
- `<TURN_DOMAIN>` → публичный IP, DNAT UDP 50000–60000 + 3478 → `<APP_SERVER>` (coturn + LiveKit RTC).

---

## 2. Подготовка app-сервера (one-time)

### 2.1. Базовая ОС
- Debian 12+ / Ubuntu 22.04+ LTS.
- Минимум **16 vCPU, 32 GB RAM, 500 GB NVMe** (см. ТЗ 5.1).
- Публичный IP с открытыми портами:
  - **443/TCP** для reverse-proxy (если он на отдельном хосте — может не нужно открывать наружу).
  - **3478/UDP+TCP** для coturn (STUN/TURN).
  - **50000-60000/UDP** для LiveKit RTC.
  - **22/TCP** для администрирования (с allowlist).

### 2.2. Docker
```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# logout/login или newgrp docker
docker --version          # ≥ 24.0
docker compose version    # v2 plugin
```

### 2.3. Файрвол (UFW)
```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow from <ADMIN_SUBNET> to any port 22 proto tcp
sudo ufw allow 3478/udp
sudo ufw allow 3478/tcp
sudo ufw allow 50000:60000/udp
sudo ufw allow from <PROXY_HOST_IP> to any port 18001 proto tcp   # proxy → web
sudo ufw enable
```

### 2.4. Каталоги
```bash
sudo mkdir -p /opt/toolkit
sudo chown $USER:$USER /opt/toolkit
sudo mkdir -p /opt/toolkit/data/{postgres,minio,opensearch,prometheus,grafana,loki,egress}
```

---

## 3. Первичный деплой

### 3.1. Клонирование
```bash
cd /opt
git clone https://github.com/<ORG>/toolkit.git
cd toolkit
```

### 3.2. Секреты
```bash
cp .env.example .env
$EDITOR .env
```

**Обязательно поменять:**

| Переменная | Что вписать |
|---|---|
| `POSTGRES_PASSWORD` | случайный 32+ символов |
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | случайные, ≥ 8 символов |
| `OPENSEARCH_INITIAL_ADMIN_PASSWORD` | случайный, ≥ 12 |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | сгенерировать `livekit-cli generate-keys` или openssl rand |
| `COTURN_STATIC_AUTH_SECRET` | случайный, 32+ |
| `COTURN_REALM` | `<TURN_DOMAIN>` |
| `COTURN_EXTERNAL_IP` | публичный IP, на который DNAT'ится UDP |
| `GRAFANA_ADMIN_PASSWORD` | случайный |
| `JWT_SECRET` | 64+ символов |
| `BITRIX_*` | из локального приложения вашего портала Bitrix24 |
| `FREEPBX_*` | согласовать с командой АТС |
| `GIGAAM_*` | согласовать с командой ASR |
| `SMTP_*` + `ALERT_EMAIL_TO` | корпоративный SMTP + куда слать алерты |
| `TOOLKIT_BOOTSTRAP_ADMINS` | email-ы первых админов из Bitrix24 |
| `APP_BIND_ADDRESS` | приватный IP app-сервера, на котором web слушает за прокси |

### 3.3. Параметры reverse-proxy

| Параметр | Значение |
|---|---|
| Domain | `<TOOLKIT_DOMAIN>` |
| Forward Hostname/IP | `<APP_SERVER>` |
| Forward Port | `18001` (= `APP_BIND_PORT`) |
| Scheme | `http` |
| Block Common Exploits | on |
| Websockets Support | **on** (обязательно для WSS — LiveKit и API events) |
| SSL → Force SSL | on |
| SSL → Let's Encrypt | on |
| `client_max_body_size` | `100m` (для загрузок) |
| `proxy_read_timeout` | `600s` (для долгих SSE/WSS) |

### 3.4. Запуск
```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

Стек поднимется в таком порядке:
1. `postgres`, `minio`, `opensearch`, `redis` — data layer
2. `minio-init` — создаёт buckets `recordings`, `reports`, `backups`
3. `migrate` — прогоняет SQL-миграции
4. `livekit`, `livekit-egress`, `coturn` — media
5. `api`, `worker` — приложение
6. `web-build` → `web` (nginx) — статика SPA + reverse-proxy на api
7. `prometheus`, `loki`, `promtail`, `grafana`, `node-exporter`, `postgres-exporter` — observability
8. `postgres-backup` — фоновый бэкап

---

## 4. Smoke-тесты после деплоя

```bash
make smoke              # из /opt/toolkit
```

Должно вернуться:
- postgres: `accepting connections`
- minio: `OK`
- opensearch: `"status":"yellow"` или `"green"`
- livekit: `OK`
- grafana: `{"database":"ok",...}`
- prometheus: `Healthy`

### 4.1. Дополнительно
```bash
# Веб-фронт через прокси
curl -I https://<TOOLKIT_DOMAIN>

# Grafana доступна только с приватного интерфейса (по умолчанию)
ssh -L 3001:<APP_SERVER>:3001 user@bastion
# открыть http://localhost:3001 → admin / GRAFANA_ADMIN_PASSWORD

# В Grafana должны быть:
#  - Datasources: Prometheus, Loki
#  - Folder "Toolkit" с дашбордами: System, PostgreSQL, LiveKit, API
#  - Folder "Toolkit Alerts" с правилами

# Проверь что таргеты Prometheus собираются:
ssh -L 9090:<APP_SERVER>:9090 user@bastion
# открыть http://localhost:9090/targets — все state=UP
```

### 4.2. Проверить бэкап
```bash
make backup-now
make backup-list
# Должен появиться файл вида toolkit-YYYYMMDDTHHMMSSZ.dump
```

---

## 5. Обновление и откат

### 5.1. Обновление
```bash
cd /opt/toolkit
git pull
docker compose -f docker-compose.yml -f docker-compose.prod.yml pull
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
# миграции БД запускаются автоматически контейнером migrate
```

### 5.2. Откат
```bash
git checkout v<previous-tag>
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
# Откатные миграции (если есть): docker compose run --rm migrate ./toolkit migrate --cmd=down --steps=1
```

### 5.3. Перечитать алерты Grafana без рестарта
Алерт-правила и contact-points применяются только при старте Grafana. После изменения файлов в `ops/grafana/provisioning/alerting/`:
```bash
docker compose restart grafana
```

Дашборды (JSON в `provisioning/dashboards/`) — провайдер перечитывает каждые 30s, рестарт не нужен.

---

## 6. Бэкап и восстановление

### 6.1. Что бэкапим
| Что | Куда | Расписание | Retention |
|---|---|---|---|
| PostgreSQL pg_dump | MinIO bucket `backups` | каждые 24ч (`BACKUP_INTERVAL_SECONDS`) | `BACKUP_RETENTION_DAYS` дней |
| MinIO bucket `recordings` | копия на отдельный носитель/бакет | по retention из админки | по политике |
| Audit-log snapshot | MinIO bucket `backups` (отдельный путь) | ежесуточно из app | долгосрочно |

RPO ≤ 24ч / RTO ≤ 2ч соответствуют ТЗ MVP 5.3.

### 6.2. Восстановление БД
```bash
# 1. Достать дамп из MinIO
docker compose exec minio sh -c \
  'mc alias set local http://minio:9000 $MINIO_ROOT_USER $MINIO_ROOT_PASSWORD && mc cp local/backups/<file>.dump /tmp/'

# 2. Положить рядом с postgres
docker cp $(docker compose ps -q minio):/tmp/<file>.dump ./<file>.dump
docker cp ./<file>.dump $(docker compose ps -q postgres):/tmp/

# 3. Восстановить (DESTRUCTIVE — стирает текущую БД)
docker compose exec postgres pg_restore --clean --if-exists \
  -U $POSTGRES_USER -d $POSTGRES_DB /tmp/<file>.dump

# 4. Перезапустить api/worker для пересоздания пулов
docker compose restart api worker
```

---

## 7. Мониторинг и алерты

### 7.1. Дашборды (Grafana → Toolkit)
- **System (host)** — CPU, RAM, disk, network. Источник: node-exporter.
- **PostgreSQL** — connections, transactions, deadlocks, размер БД. Источник: postgres-exporter.
- **LiveKit (ВКС)** — комнаты, участники, треки, throughput. Источник: livekit /metrics.
- **API** — request rate, p95 latency, error rate, очередь джобов. Источник: apps/api /metrics.

### 7.2. Алерты (email → `ALERT_EMAIL_TO`)
| Имя | Триггер | Severity |
|---|---|---|
| disk-usage-high | >80% на любом mount > 10 мин | warning |
| postgres-down | pg_up=0 > 2 мин | critical |
| livekit-down | up{livekit}=0 > 2 мин | critical |
| api-down | up{api}=0 > 2 мин | critical |
| api-error-rate-high | 5xx > 5% за 5 мин | warning |
| bitrix24-down | external_service_up{bitrix24}=0 > 5 мин | critical |
| freepbx-down | external_service_up{freepbx}=0 > 2 мин | critical |
| gigaam-down | external_service_up{gigaam}=0 > 15 мин | warning |
| backup-failures | >1 ошибка за сутки | critical |

### 7.3. Логи (Grafana → Explore → Loki)
Все контейнеры пишут stdout в Docker log driver, Promtail парсит и заливает в Loki.
```
{container="toolkit-api-1"} |= "ERROR"
```

---

## 8. Что делать при инциденте

### 8.1. Bitrix24 SSO down
- Новые входы блокируются (503), существующие сессии работают до истечения access (15 мин).
- Действия: проверить портал Bitrix24 с другой машины. Открыть тикет в команду Bitrix24-админов.

### 8.2. FreePBX down
- Софтфон не примет/не сделает звонки. ВКС работает.
- CDR-импорт остановится — после восстановления догонит.
- Действия: команда АТС → ssh на FreePBX → `asterisk -rx "core show channels"`.

### 8.3. GigaAM down
- Очередь транскрибации растёт. Уже сделанные транскрипты доступны.
- Действия: команда ASR. После восстановления `worker` перезапустит зависшие задачи.

### 8.4. Сервер целиком недоступен
- См. раздел 6.2 — восстановить БД из последнего бэкапа на запасном хосте.
- В MVP-версии нет HA — простой ~2ч (RTO).

---

## 9. Чек-лист перед сдачей в эксплуатацию

- [ ] `.env` заполнен полностью, файл с правами 600
- [ ] `git status` чистый, тег версии релиза на текущем HEAD
- [ ] `make smoke` зелёный (все health-эндпоинты)
- [ ] Grafana login работает, видны 4 дашборда
- [ ] Все 9 алертов появились в `Alerting → Alert rules`
- [ ] Тестовое письмо алерта дошло на `ALERT_EMAIL_TO`
- [ ] `make backup-now` создал файл, видно в MinIO
- [ ] Reverse-proxy настроен, `https://<TOOLKIT_DOMAIN>` отвечает
- [ ] DNS `<TURN_DOMAIN>` резолвится в публичный IP, port 3478 reachable снаружи
- [ ] Тестовый WebRTC-вызов на служебный extension прошёл (TURN не зависает)
- [ ] Backup retention проверен: после 30+ дней старые файлы удаляются
- [ ] Логи в Grafana → Loki видны для всех контейнеров
- [ ] Bootstrap-админ зашёл и видит admin-панель
