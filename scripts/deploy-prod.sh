#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
REMOTE="${TOOLKIT_PROD_REMOTE:-root@10.10.0.17}"
REMOTE_DIR="${TOOLKIT_PROD_DIR:-/opt/toolkit}"

rsync -az --delete \
  --exclude .env \
  --exclude .git \
  --exclude node_modules \
  --exclude apps/web/dist \
  --exclude data \
  "$ROOT_DIR/" "$REMOTE:$REMOTE_DIR/"

ssh "$REMOTE" "cd '$REMOTE_DIR' && docker compose --env-file .env -f docker-compose.yml -f docker-compose.prod.yml up --build --force-recreate --no-deps web-build && docker compose --env-file .env -f docker-compose.yml -f docker-compose.prod.yml up -d --no-deps web api worker"
