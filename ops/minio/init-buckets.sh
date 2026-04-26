#!/bin/sh
# Создаёт бакеты MinIO при первом старте стека.
set -eu

mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"

for bucket in "$MINIO_BUCKET_RECORDINGS" "$MINIO_BUCKET_REPORTS" "$MINIO_BUCKET_BACKUPS"; do
  if mc ls "local/$bucket" >/dev/null 2>&1; then
    echo "bucket $bucket already exists"
  else
    mc mb "local/$bucket"
    echo "bucket $bucket created"
  fi
done

# Политика: приватные бакеты (доступ только по подписанным ссылкам и сервисным ключам)
mc anonymous set none "local/$MINIO_BUCKET_RECORDINGS" || true
mc anonymous set none "local/$MINIO_BUCKET_REPORTS" || true
mc anonymous set none "local/$MINIO_BUCKET_BACKUPS" || true

echo "minio-init: done"
