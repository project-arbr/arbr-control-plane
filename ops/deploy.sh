#!/usr/bin/env bash
# Gated, image-based, rollback-safe manual deploy for arbr.gyde.ai.
#
# Pulls a CI-published GHCR image (image-exists ⇒ CI green = the gate), swaps the app
# container to it, health-checks, and AUTO-ROLLS-BACK to the previous tag on failure.
# Re-runs the LiteLLM sync if the model seed version changed (so pricing doesn't silently
# regress), then notifies the governance webhook. No build happens on the prod host.
#
# Usage (on the VM):  bash ops/deploy.sh [TAG]     TAG defaults to "main" (latest green).
#   e.g.  bash ops/deploy.sh sha-1a2b3c4     (pin to a specific commit)
set -euo pipefail

REPO="$HOME/arbr-ai-control-plane"
IMAGE="ghcr.io/project-arbr/arbr-control-plane"
COMPOSE="sudo docker compose -f docker-compose.yml -f docker-compose.gcp.yml -f docker-compose.deploy.yml"
PREV_FILE="$HOME/.arbr-deploy-prev"
HEALTH="http://localhost:4100/health"
API="http://localhost:4100/api"
TAG="${1:-main}"

cd "$REPO"

# Keep compose files + this script current (no build; pulls yaml/script only).
git pull --ff-only || echo "!! git pull skipped (non-ff); continuing with local compose files"

# 1. GATE: the image must exist. CI publishes it only after test+lint+build pass.
echo "==> Verifying ${IMAGE}:${TAG} exists (= CI green)…"
if ! sudo docker manifest inspect "${IMAGE}:${TAG}" >/dev/null 2>&1; then
  echo "!! No image ${IMAGE}:${TAG} in GHCR — CI hasn't published it (tests failed / still running) or the tag is wrong. Aborting; nothing changed."
  exit 1
fi

# Admin key from the running container (admin API is auth-gated). Used for seed check + notify.
KEY="$($COMPOSE exec -T app printenv ARBR_ADMIN_KEY 2>/dev/null | tr -d '\r' || true)"
AUTH=(); [ -n "$KEY" ] && AUTH=(-H "Authorization: Bearer $KEY")
seed_of() { curl -s "${AUTH[@]}" "$API/about" 2>/dev/null | sed -n 's/.*"modelSeedVersion":\([0-9]*\).*/\1/p'; }
notify() {  # $1 = message text
  local url; url="$(curl -s "${AUTH[@]}" "$API/governance" 2>/dev/null | sed -n 's/.*"webhookUrl":"\([^"]*\)".*/\1/p')"
  [ -n "$url" ] && curl -s -X POST "$url" -H "Content-Type: application/json" -d "{\"text\":\"$1\"}" >/dev/null 2>&1 || true
}
deploy() {  # $1 = tag
  ARBR_IMAGE_TAG="$1" $COMPOSE pull app
  ARBR_IMAGE_TAG="$1" $COMPOSE up -d --no-build app
}

SEED_BEFORE="$(seed_of || true)"
PREV_TAG="$(cat "$PREV_FILE" 2>/dev/null || echo main)"
echo "==> Current tag: ${PREV_TAG}  →  deploying: ${TAG}"

# 2. DEPLOY.
deploy "$TAG"

# 3. HEALTH GATE: poll /health up to ~60s.
ok=0
for _ in $(seq 1 20); do
  sleep 3
  if curl -fsS "$HEALTH" >/dev/null 2>&1; then ok=1; break; fi
done

# 4. ROLLBACK on failure.
if [ "$ok" != "1" ]; then
  echo "!! Health check failed on ${TAG}. Rolling back to ${PREV_TAG}…"
  deploy "$PREV_TAG"
  notify "⚠️ Arbr deploy FAILED on ${TAG} — rolled back to ${PREV_TAG} (arbr.gyde.ai)."
  echo "!! Rolled back to ${PREV_TAG}. Deploy aborted."
  exit 1
fi

# 5. SUCCESS: record tag; re-run LiteLLM sync if the seed version changed.
echo "$TAG" > "$PREV_FILE"
SEED_AFTER="$(seed_of || true)"
if [ -n "$SEED_AFTER" ] && [ "$SEED_BEFORE" != "$SEED_AFTER" ]; then
  echo "==> Model seed ${SEED_BEFORE:-?} → ${SEED_AFTER}: re-running LiteLLM sync (pricing refresh)…"
  curl -s -X POST "${AUTH[@]}" "$API/litellm/sync" >/dev/null 2>&1 || echo "!! LiteLLM sync call failed — run it manually."
fi
notify "✅ Arbr deployed ${TAG} to arbr.gyde.ai — healthy."
echo "==> Done. Deployed ${TAG} (previous: ${PREV_TAG})."
