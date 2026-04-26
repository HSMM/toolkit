# Toolkit — runbook развёртывания

Документ для DevOps/админа. Описывает первичный деплой и эксплуатацию Toolkit на app-сервере **`10.10.0.17`** (`/opt/toolkit`).

Связанные документы:
- `../toolkit-tz/toolkit-tz-mvp-v1.0.md` — ТЗ MVP (раздел 5.5 — окружение).
- `../toolkit-tz/toolkit-architecture.md` — архитектура.
- `README.md` — быстрый старт локально.

---

## 1. Топология

```
            публичный IP (граничное оборудование заказчика)
                 │
        DNAT 443/TCP        DNAT 3478 + 50000-60000/UDP
                 ▼                    ▼
   ┌──────────────────────┐   ┌──────────────────────┐
   │ NPM (Nginx Proxy Mgr)│   │  app-сервер          │
   │ 10.10.0.61:443       │   │  10.10.0.17          │
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
- `toolkit.softservice.by` → публичный IP, DNAT 443/TCP → `10.10.0.61:443` (NPM).
- `turn.softservice.by` → публичный IP, DNAT UDP 50000–60000 + 3478 → `10.10.0.17` (coturn + LiveKit RTC).

---

## 2. Подготовка app-сервера (one-time)

### 2.1. Базовая ОС
- Debian 12 / Ubuntu 22.04 LTS (или новее).
- Минимум 16 vCPU, 32 GB RAM, 500 GB NVMe (см. ТЗ 5.1).
- Публичный IP с открытыми портами:
  - **443/TCP** для NPM proxy_pass (если NPM на отдельном хосте — может не нужно открывать наружу).
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
sudo ufw allow from 10.10.0.0/24 to any port 22 proto tcp
sudo ufw allow 3478/udp
sudo ufw allow 3478/tcp
sudo ufw allow 50000:60000/udp
sudo ufw allow from 10.10.0.61 to any port 18001 proto tcp  # NPM → web
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

### 3.1. Клон репо
```bash
cd /opt
git clone https://oauth2:<PAT>@git.vitai.world/<group>/toolkit.git
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
| `COTURN_REALM` | `turn.softservice.by` |
| `COTURN_EXTERNAL_IP` | публичный IP, на который DNAT'ится UDP |
| `GRAFANA_ADMIN_PASSWORD` | случайный |
| `JWT_SECRET` | 64+ символов |
| `BITRIX_*` | из локального приложения portal.softservice.by |
| `FREEPBX_*` | согласовать с командой АТС |
| `GIGAAM_*` | согласовать с командой ASR |
| `SMTP_*` + `ALERT_EMAIL_TO` | корпоративный SMTP + куда слать алерты |
| `TOOLKIT_BOOTSTRAP_ADMINS` | email-ы первых админов из Bitrix24 |

### 3.3. Параметры NPM proxy host (передать команде прокси на 10.10.0.61)

| Параметр | Значение |
|---|---|
| Domain | `toolkit.softservice.by` |
| Forward Hostname/IP | `10.10.0.17` |
| Forward Port | `18001` |
| Scheme | `http` |
| Block Common Exploits | on |
| Websockets Support | **on** (обязательно для WSS — LiveKit и API events) |
| SSL → Force SSL | on |
| SSL → Let's Encrypt | on, email СБ |
| Advanced → `client_max_body_size` | `100m` (для загрузок) |
| Advanced → `proxy_read_timeout` | `600s` (для долгих SSE/WSS) |

### 3.4. Запуск
```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

Стек поднимется в таком порядке:
1. `postgres`, `minio`, `opensearch`, `redis` — data layer
2. `minio-init` — создаёт buckets `recordings`, `reports`, `backups`
3. `migrate` — прогоняет SQL-миграции (E2.1+)
4. `livekit`, `livekit-egress`, `coturn` — media
5. `api`, `worker` — приложение
6. `web` (nginx) — статика SPA + прокси на api
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
# Веб-фронт через NPM
curl -I https://toolkit.softservice.by

# Grafana доступна только с приватного IP (по умолчанию)
ssh -L 3001:10.10.0.17:3001 user@bastion
# открыть http://localhost:3001 → admin / GRAFANA_ADMIN_PASSWORD

# В Grafana должны быть:
#  - Datasources: Prometheus, Loki
#  - Folder "Toolkit" с дашбордами: System, PostgreSQL, LiveKit, API
#  - Folder "Toolkit Alerts" с правилами: disk-usage-high, postgres-down, livekit-down, ...

# Проверь что таргеты Prometheus собираются:
ssh -L 9090:10.10.0.17:9090 user@bastion
# открыть http://localhost:9090/targets — все state=UP, кроме api (если ещё не написан)
```

### 4.2. Проверить бэкап
```bash
make backup-now
make backup-list
# Должен появиться файл вида toolkit-20260423T120000Z.dump
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
| MinIO bucket `recordings` | **TBD** — копия на отдельный носитель/бакет | по retention из админки | по политике |
| Audit-log snapshot | MinIO bucket `backups` (отдельный путь) | ежесуточно из app | 3 года (ТЗ 4.2) |

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
- **API** — request rate, p95 latency, error rate, очередь джобов. Источник: apps/api /metrics (активируется в эпике E3.6).

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

Внешние сервисные алерты (`bitrix24-down`, `freepbx-down`, `gigaam-down`, `backup-failures`) активируются когда apps/api expose-нёт соответствующие метрики (см. эпики E1, E5, E7, E10 декомпозиции).

### 7.3. Логи (Grafana → Explore → Loki)
Все контейнеры пишут stdout в Docker log driver, Promtail парсит и заливает в Loki.
```
{container="toolkit-api-1"} |= "ERROR"
```

---

## 8. Что делать при инциденте

### 8.1. Bitrix24 SSO down
- Новые входы блокируются (503), существующие сессии работают до истечения access (15 мин).
- Залогиненные пользователи могут потерять сессию через 15 мин.
- Действия: проверить https://portal.softservice.by с другой машины. Открыть тикет в команду Bitrix24-админов.

### 8.2. FreePBX down
- Софтфон не примет/не сделает звонки. ВКС работает.
- CDR-импорт остановится — после восстановления догонит.
- Действия: команда АТС → ssh на FreePBX → `asterisk -rx "core show channels"`.

### 8.3. GigaAM down
- Очередь транскрибации растёт. Уже сделанные транскрипты доступны.
- Действия: команда ASR. После восстановления `worker` перезапустит зависшие задачи (retry policy в E7.3).

### 8.4. Сервер целиком недоступен
- См. раздел 6.2 — восстановить БД из последнего бэкапа на запасном хосте.
- В MVP-версии нет HA — простой ~2ч (RTO).

---

## 9. Чек-лист перед сдачей в эксплуатацию

- [ ] `.env` заполнен полностью, файл с правами 600
- [ ] `git status` чистый, тег версии релиза на текущем HEAD
- [ ] `make smoke` зелёный (все health-эндпоинты)
- [ ] Grafana login работает, видны 4 дашборда
- [ ] Все 9 алертов появились в `Alerting → Alert rules` (часть в `NoData`)
- [ ] Тестовое письмо алерта дошло на `ALERT_EMAIL_TO` (Alerting → Contact points → Test)
- [ ] `make backup-now` создал файл, видно в MinIO
- [ ] NPM proxy host настроен, `https://toolkit.softservice.by` отвечает (200/302)
- [ ] DNS `turn.softservice.by` резолвится в публичный IP, port 3478 reachable снаружи
- [ ] Тестовый WebRTC-вызов на служебный extension прошёл (TURN не зависает)
- [ ] Backup retention проверен: после 30+ дней старые файлы удаляются
- [ ] Логи в Grafana → Loki видны для всех контейнеров
- [ ] Bootstrap-админ зашёл и видит admin-панель
