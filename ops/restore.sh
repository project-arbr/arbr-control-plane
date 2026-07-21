#!/usr/bin/env bash
# Restore a backup produced by ops/backup.sh. DESTRUCTIVE: --drop replaces every
# collection in the target database with the backup's contents.
#
# Usage:  bash ops/restore.sh <backup-file>
set -euo pipefail

REPO="$HOME/arbr-ai-control-plane"
COMPOSE_FILES="-f docker-compose.yml -f docker-compose.gcp.yml -f docker-compose.deploy.yml"
COMPOSE="sudo docker compose $COMPOSE_FILES"
HEALTH="http://localhost:4100/health"
FILE="${1:-}"

if [ -z "$FILE" ] || [ ! -f "$FILE" ]; then
  echo "!! Usage: bash ops/restore.sh <backup-file>"
  exit 1
fi

cd "$REPO"

echo "==> Restoring ${FILE} — this DROPS existing collections in the target database."
read -r -p "    Type 'yes' to continue: " CONFIRM
if [ "$CONFIRM" != "yes" ]; then
  echo "!! Aborted — nothing changed."
  exit 1
fi

$COMPOSE exec -T mongo mongorestore --archive --gzip --drop < "$FILE"

echo "==> Restore complete. Restarting app to pick up the restored data…"
$COMPOSE restart app

# Health gate, same pattern as ops/deploy.sh.
ok=0
for _ in $(seq 1 20); do
  sleep 3
  if curl -fsS "$HEALTH" >/dev/null 2>&1; then ok=1; break; fi
done

if [ "$ok" != "1" ]; then
  echo "!! App did not become healthy after restore — check: sudo docker compose $COMPOSE_FILES logs app"
  exit 1
fi

echo "==> Done. App is healthy post-restore."
echo "    Now run the verification checklist in docs/operational-readiness.md."
