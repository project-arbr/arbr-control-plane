# API Reference

The admin API (`/api/*`) is gated by `ARBR_ADMIN_KEY` when set. The gateway API (`/v1/*`) is gated by gateway keys (`ab_…`) when *Require API keys* is on.

All request bodies are `application/json`. All responses are JSON.

## Status

### `GET /api/status`

Returns gateway health and current settings. Accepted by both the admin key and any valid gateway key.

**Response:**
```json
{
  "demoMode": false,
  "liveProviders": ["openai", "anthropic"],
  "defaultProvider": "openai",
  "defaultModel": "gpt-4o-mini",
  "routingMode": "guardrail",
  "requireApiKey": false,
  "breachedCaps": 0
}
```

### `GET /health`

Liveness endpoint. Public — no auth required.

```json
{ "ok": true, "demoMode": false }
```

---

## Gateway

### `POST /v1/chat`

Arbr-native endpoint. See [Native endpoint](/gateway/native) for full docs.

### `POST /v1/chat/completions`

OpenAI-compatible endpoint. See [OpenAI-compatible endpoint](/gateway/openai-compat) for full docs.

---

## Model registry

### `GET /api/models`

List all enabled models.

```json
[
  { "id": "gpt-4o-mini", "provider": "openai", "label": "GPT-4o Mini", "tier": "light", "inputPer1M": 0.15, "outputPer1M": 0.60, "builtIn": true, "enabled": true }
]
```

### `POST /api/models`

Create a model entry. Returns 409 if the ID already exists.

```json
{
  "id": "my-model",
  "provider": "openai",
  "label": "My Fine-tuned Model",
  "tier": "mid",
  "inputPer1M": 2.0,
  "outputPer1M": 8.0
}
```

### `PATCH /api/models/:id`

Update label, tier, prices, or enabled state. Only the fields you send are changed.

```json
{ "inputPer1M": 1.8, "outputPer1M": 7.0, "tier": "light" }
```

### `DELETE /api/models/:id`

Delete a custom model entry. Returns 403 for built-in models (disable them with `enabled: false` instead).

---

## Budgets (caps)

### `GET /api/caps`

List all caps with current spend and breach status.

```json
[{
  "_id": "abc123",
  "dimension": "application",
  "value": "support-chat",
  "period": "month",
  "limit": 50.0,
  "action": "downgrade",
  "enabled": true,
  "spent": 12.34,
  "pct": 0.247,
  "breached": false
}]
```

### `POST /api/caps`

Create a budget cap.

```json
{
  "dimension": "application",
  "value": "support-chat",
  "period": "month",
  "limit": 50.0,
  "action": "downgrade"
}
```

`dimension` options: `application`, `provider`, `department`, `workflow`, `model`. Omit for a global cap.
`action` options: `alert`, `downgrade`, `block`.

### `PATCH /api/caps/:id`

Update a cap (enabled, limit, period, action).

### `DELETE /api/caps/:id`

Delete a cap.

---

## Gateway API keys

### `GET /api/keys`

List all gateway API keys (raw key never returned — only metadata).

```json
[{
  "_id": "abc123",
  "prefix": "ab_abc1",
  "application": "support-chat",
  "rpmLimit": 60,
  "enabled": true,
  "createdAt": "2024-01-01T00:00:00.000Z"
}]
```

### `POST /api/keys`

Create a new gateway key. The raw key is returned **once** — it cannot be retrieved again.

```json
{ "application": "support-chat", "rpmLimit": 60 }
```

Response:
```json
{ "key": "ab_abc1…", "prefix": "ab_abc1", "application": "support-chat" }
```

### `PATCH /api/keys/:id`

Enable/disable a key or update its RPM limit.

### `DELETE /api/keys/:id`

Revoke a key permanently.

---

## Routing rules

### `GET /api/rules`

List all routing rules.

### `POST /api/rules`

Create a routing rule.

```json
{
  "condition": { "field": "taskType", "value": "classification" },
  "action": { "provider": "openai", "model": "gpt-4o-mini" },
  "enabled": false
}
```

### `PATCH /api/rules/:id`

Enable/disable or update a rule.

### `DELETE /api/rules/:id`

Delete a rule.

---

## Routing settings

### `GET /api/routing/mode`

Current routing mode: `"off"` | `"guardrail"` | `"ai"`.

### `POST /api/routing/mode`

Set routing mode.

```json
{ "mode": "guardrail" }
```

### `GET /api/routing/policy`

The current AI routing policy (task → model map).

### `POST /api/routing/policy/regenerate`

Regenerate the AI routing policy using the default model.

---

## Analytics

### `GET /api/analytics/overview`

Aggregated cost, token, and request counts. Includes:
- `cacheHitRate`, `cachedReadTokens`, `cacheSavingUsd` — prompt-cache observability
- `totalSaved` — realised savings from model substitutions (requests served cheaper than requested)

### `GET /api/analytics/by-dimension`

Breakdown by `application`, `model`, `provider`, `department`, `workflow`, `taskType`, or `user`. Pass `?dimension=user&from=2024-01-01`. Null `userId` groups as `(unattributed)`.

### `GET /api/analytics/realised-savings`

Groups successful requests where the served model differed from the requested model, re-prices the served tokens at the requested model's rate, and returns the delta. Excludes `auto` requests (no requested baseline) and requests with unknown pricing.

```json
{
  "totalSaved": 1.23,
  "rows": [
    { "requested": "gpt-4o", "served": "gpt-4o-mini", "requests": 142, "saved": 1.23 }
  ]
}
```

### `GET /api/requests`

Paginated request log. Supports filtering by application, model, provider, status, date range. Each record includes `routingExplain`, `difficulty`, `difficultyScore`, `confidence`, and `cacheSavingUsd`.

---

## Recommendations

### `GET /api/recommendations`

List current recommendations.

### `POST /api/recommendations/recompute`

Re-run the recommendation engine against recent request records.

### `POST /api/recommendations/:id/accept`

Accept a recommendation — creates a disabled routing rule ready to review and enable.

### `DELETE /api/recommendations/:id`

Dismiss a recommendation.

---

## Provider connections

### `GET /api/connections`

List all providers with their connection status and default model.

### `POST /api/connections/:providerId`

Store or update a provider credential (encrypted at rest).

### `DELETE /api/connections/:providerId`

Remove a stored credential (falls back to env var if set).
