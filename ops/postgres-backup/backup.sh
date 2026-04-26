#!/bin/sh
# PostgreSQL → MinIO backup loop.
# Бэкап pg_dump (custom format, сжатие 9), upload в bucket BACKUP_BUCKET, retention BACKUP_RETENTION_DAYS.
# Управляющие env: см. docker-compose.yml сервис postgres-backup.

set -eu

: "${POSTGRES_HOST:?required}"
: "${POSTGRES_USER:?required}"
: "${POSTGRES_PASSWORD:?required}"
: "${POSTGRES_DB:?required}"
: "${MINIO_URL:?required}"
: "${MINIO_ROOT_USER:?required}"
: "${MINIO_ROOT_PASSWORD:?required}"
: "${BACKUP_BUCKET:?required}"
: "${BACKUP_RETENTION_DAYS:?required}"
: "${BACKUP_INTERVAL_SECONDS:?required}"

export PGPASSWORD="$POSTGRES_PASSWORD"

mc alias set toolkit "$MINIO_URL" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null

run_backup() {
    ts="$(date -u +%Y%m%dT%H%M%SZ)"
    file="/tmp/${POSTGRES_DB}-${ts}.dump"
    echo "[backup] $(date -Iseconds) starting pg_dump → ${file}"
    pg_dump --format=custom --compress=9 \
        --host="$POSTGRES_HOST" --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" \
        --file="$file"
    size=$(wc -c < "$file")
    echo "[backup] dump done, ${size} bytes → uploading"
    mc cp --quiet "$file" "toolkit/${BACKUP_BUCKET}/$(basename "$file")"
    rm -f "$file"
    echo "[backup] uploaded. applying retention >${BACKUP_RETENTION_DAYS}d"
    mc rm --recursive --force --older-than "${BACKUP_RETENTION_DAYS}d" "toolkit/${BACKUP_BUCKET}/" 2>&1 | tail -3 || true
    echo "[backup] cycle complete at $(date -Iseconds)"
}

# Если ON_START_BACKUP=1 — бэкап при старте, иначе ждём BACKUP_INTERVAL_SECONDS
if [ "${ON_START_BACKUP:-0}" = "1" ]; then
    run_backup
fi

while true; do
    sleep "$BACKUP_INTERVAL_SECONDS"
    if ! run_backup; then
        echo "[backup] FAILED at $(date -Iseconds)" >&2
    fi
done
