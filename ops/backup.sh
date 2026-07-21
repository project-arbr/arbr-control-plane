#!/usr/bin/env bash
# Mongo backup for arbr's control-plane database, via mongodump run inside the mongo
# container. Mongo runs on a named Docker volume (arbr_mongo_data), not a bind mount —
# this is the supported way to get data out without stopping the container.
# Companion: ops/restore.sh.
#
# Usage:  bash ops/backup.sh [output-dir]     output-dir defaults to ./backups
set -euo pipefail

REPO="$HOME/arbr-ai-control-plane"
COMPOSE_FILES="-f docker-compose.yml -f docker-compose.gcp.yml -f docker-compose.deploy.yml"
COMPOSE="sudo docker compose $COMPOSE_FILES"
OUT_DIR="${1:-$REPO/backups}"

cd "$REPO"
mkdir -p "$OUT_DIR"

# Read the real database name from the running app container rather than hardcode it —
# MONGO_URI is mongodb://mongo:27017/<db>[?options].
DB="$($COMPOSE exec -T app printenv MONGO_URI 2>/dev/null | tr -d '\r' | sed -n 's#.*/\([^/?]*\)\(?.*\)\{0,1\}$#\1#p')"
DB="${DB:-arbr-control-plane}"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_FILE="$OUT_DIR/arbr-${DB}-${TS}.archive.gz"

echo "==> Backing up database '${DB}' to ${OUT_FILE}…"
$COMPOSE exec -T mongo mongodump --archive --gzip --db="$DB" > "$OUT_FILE"

SIZE="$(du -h "$OUT_FILE" | cut -f1)"
echo "==> Done. ${OUT_FILE} (${SIZE})"
echo "    Restore with: bash ops/restore.sh ${OUT_FILE}"
