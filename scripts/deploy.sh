#!/usr/bin/env bash
# Deploy arbr.gyde.ai from git. Pulls latest main, rebuilds the app container,
# restarts, runs the model seed ONLY when seedModels.js changed, flags removed
# model IDs (manual prune), and verifies health. Never runs the record-wiping
# full seed (seed.js).
#
# Usage (on the VM): bash scripts/deploy.sh
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.gcp.yml"
SEEDFILE="server/src/seed/seedModels.js"
cd "$REPO"

ids() { git show "$1:$SEEDFILE" 2>/dev/null | grep -oE "id:[[:space:]]*\"[^\"]+\"" | sed -E "s/id:[[:space:]]*\"([^\"]+)\"/\1/" | sort -u; }

OLD=$(git rev-parse HEAD)
echo "==> Pulling (current $OLD)"
git pull --ff-only
NEW=$(git rev-parse HEAD)

if [ "$OLD" = "$NEW" ]; then
  echo "==> Already up to date at $NEW. Nothing to deploy."
  exit 0
fi
echo "==> Updated $OLD -> $NEW"
echo "Changed files:"; git diff --name-only "$OLD" "$NEW" | sed "s/^/    /"

echo "==> Rebuilding app"
sudo $COMPOSE build app
sudo $COMPOSE up -d app

# Seed only if the model seed file changed in this range.
if git diff --name-only "$OLD" "$NEW" | grep -qx "$SEEDFILE"; then
  echo "==> $SEEDFILE changed: running model seed (builtIn baseline only)"
  sleep 3
  sudo $COMPOSE exec -T app node "$SEEDFILE"
  REMOVED=$(comm -23 <(ids "$OLD") <(ids "$NEW") || true)
  if [ -n "$REMOVED" ]; then
    echo "!!  WARNING: these model IDs were removed/renamed in the seed but the seed"
    echo "!!  does NOT delete old builtIn docs. Prune manually if they are stale:"
    echo "$REMOVED" | sed "s/^/!!      /"
    echo "!!  e.g. sudo $COMPOSE exec -T mongo mongosh arbr-control-plane --quiet \\"
    echo "!!         --eval 'db.modelentries.deleteOne({id:\"<id>\", builtIn:true})'"
  fi
else
  echo "==> Seed file unchanged: skipping seed."
fi

echo "==> Health check"
sleep 2
echo -n "  local:  "; curl -s localhost:4100/health; echo
echo -n "  public: "; curl -s https://arbr.gyde.ai/health; echo
echo "==> Done. Now at $NEW"
