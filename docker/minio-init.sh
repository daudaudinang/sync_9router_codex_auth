#!/bin/sh
set -eu

mc alias set "$MINIO_ALIAS" "$MINIO_ENDPOINT_INTERNAL" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
mc mb --ignore-existing "$MINIO_ALIAS/$MINIO_BUCKET"
mc anonymous set none "$MINIO_ALIAS/$MINIO_BUCKET" >/dev/null 2>&1 || true

echo "[minio-init] bucket ready: $MINIO_BUCKET"
