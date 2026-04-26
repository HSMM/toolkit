# Toolkit — удобные команды.

.PHONY: help up down logs ps clean reset prod-up prod-down backup-now backup-list grafana-reload smoke

help:
	@echo "Toolkit dev stack commands:"
	@echo "  make up            — поднять dev-стек (docker compose up -d, включая web-build)"
	@echo "  make down          — остановить стек (сохраняет данные)"
	@echo "  make logs          — хвост логов всех контейнеров"
	@echo "  make logs-livekit  — логи конкретного сервиса"
	@echo "  make ps            — статус контейнеров"
	@echo "  make clean         — остановить + удалить volumes (DESTRUCTIVE)"
	@echo "  make reset         — clean + up"
	@echo "  make smoke         — smoke-проверки health-эндпоинтов после старта"
	@echo "  make backup-now    — снять бэкап БД немедленно (вне расписания)"
	@echo "  make backup-list   — список бэкапов в MinIO"
	@echo "  make grafana-reload— перечитать provisioning без перезапуска (через Grafana API)"
	@echo ""
	@echo "Frontend:"
	@echo "  make web-rebuild   — пересобрать фронтенд (после изменений в apps/web)"
	@echo "  make web-dev       — Vite dev-server на :5173 (вне docker-compose, нужен Node 20+ и npm install в apps/web)"
	@echo ""
	@echo "Production:"
	@echo "  make prod-up       — prod-стек (docker-compose.prod.yml override)"
	@echo "  make prod-down     — остановить prod-стек"

up:
	docker compose up -d

down:
	docker compose down

logs:
	docker compose logs -f --tail=100

logs-%:
	docker compose logs -f --tail=100 $*

ps:
	docker compose ps

clean:
	docker compose down -v
	rm -rf ./data

reset: clean up

smoke:
	@echo "→ postgres:";  docker compose exec -T postgres pg_isready -U $$POSTGRES_USER -d $$POSTGRES_DB || true
	@echo "→ minio:";     curl -fsS http://localhost:$${MINIO_API_PORT:-9000}/minio/health/live && echo OK || echo FAIL
	@echo "→ opensearch:"; curl -fsS http://localhost:$${OPENSEARCH_PORT:-9200}/_cluster/health | head -c 200 && echo
	@echo "→ livekit:";   curl -fsS http://localhost:$${LIVEKIT_HTTP_PORT:-7880}/ && echo OK || echo FAIL
	@echo "→ grafana:";   curl -fsS http://localhost:$${GRAFANA_PORT:-3001}/api/health && echo
	@echo "→ prometheus:"; curl -fsS http://localhost:$${PROMETHEUS_PORT:-9090}/-/healthy && echo

backup-now:
	docker compose run --rm -e ON_START_BACKUP=1 -e BACKUP_INTERVAL_SECONDS=999999 postgres-backup

backup-list:
	@docker compose exec -T minio sh -c 'mc alias set local http://minio:9000 "$$MINIO_ROOT_USER" "$$MINIO_ROOT_PASSWORD" >/dev/null && mc ls local/$$MINIO_BUCKET_BACKUPS/' || \
	  echo "MinIO ещё не поднят или бэкапов нет"

grafana-reload:
	@echo "Grafana provisioning перечитывается автоматически каждые 30s (см. dashboards.yml)."
	@echo "Алерты и datasources применяются при старте — для пересмотра нужен restart:"
	@echo "  docker compose restart grafana"

web-rebuild:
	docker compose build web-build
	docker compose up -d --force-recreate web-build web

web-dev:
	cd apps/web && npm install --no-audit --no-fund && VITE_API_TARGET=http://localhost:8080 npm run dev

prod-up:
	docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

prod-down:
	docker compose -f docker-compose.yml -f docker-compose.prod.yml down
