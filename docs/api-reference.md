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

Liveness endpoint. Public — no auth required. Always 200 if the process is up — never depends
on Mongo being reachable, so it must not be used as a readiness probe.

```json
{ "ok": true, "demoMode": false }
```

### `GET /health/ready`

Readiness endpoint. Public — no auth required. Returns `503` while draining after SIGTERM/SIGINT
or while Mongo is disconnected — a load balancer or orchestrator should stop routing new traffic
here on `503`, without treating the instance as dead. See
[Operational readiness](/operational-readiness) for the liveness-vs-readiness distinction.

```json
{ "ok": true, "ready": true, "reason": null }
```
```json
{ "ok": false, "ready": false, "reason": "shutting_down" }
```

---

## Gateway

### `POST /v1/chat`

Arbr-native endpoint. See [Native endpoint](/gateway/native) for full docs.

### `POST /v1/chat/completions`

OpenAI-compatible endpoint. See [OpenAI-compatible endpoint](/gateway/openai-compat) for full docs.

### `POST /v1/ingest`

Reports metadata for calls that already happened elsewhere (a partner's own gateway, LiteLLM, ...) with no live provider call. See [Observe-only ingestion](/gateway/observe-only-ingestion) for full docs.

### `POST /v1/embeddings`

OpenAI-compatible embeddings endpoint — routes to Gemini or an OpenAI-compat provider based on the model ID, with the same observability as the chat endpoints.

### `GET /v1/models`

Lists models whose provider is currently connected (live), in the OpenAI model-list shape, with a `toolCallSupported` flag per model.

### `GET /v1/task-types`

Lists all supported task types with tier and description.

### `GET /v1/providers`

Lists which providers are currently live and the model IDs each one serves. No credentials exposed.

### `/v1/realtime` (WebSocket)

Realtime voice session proxy. Authenticated the same way as the HTTP gateway (`Authorization: Bearer ab_…`) at the WebSocket upgrade — see `server/src/gateway/wsAuth.js`.

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

Delete a custom model entry. Returns 400 for built-in models (disable them with `enabled: false` instead).

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
  "rpm": 60,
  "enabled": true,
  "expiresAt": null,
  "createdAt": "2024-01-01T00:00:00.000Z"
}]
```

### `POST /api/keys`

Create a new gateway key. The raw key is returned **once** — it cannot be retrieved again. `name` and `application` are both required (400 if either is missing).

```json
{ "name": "Support bot", "application": "support-chat", "rpm": 60, "expiresAt": "2026-12-31T00:00:00.000Z" }
```

`expiresAt` is optional — omit it (or pass `null`) for a key that never expires. Once it passes, the key is rejected with `401 expired_api_key`.

Response:
```json
{ "key": "ab_abc1…", "prefix": "ab_abc1", "application": "support-chat", "expiresAt": null }
```

### `PATCH /api/keys/:id`

Enable/disable a key, update its RPM limit, or change `expiresAt`.

### `DELETE /api/keys/:id`

Revoke a key permanently.

### `POST /api/keys/:id/rotate`

Revoke the key and create a replacement with identical settings (name, application, `rpm`, `allowedModels`, `defaultModel`). Returns the new key's metadata plus its raw secret **once**, same shape as `POST /api/keys`.

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

### `GET /api/routing-mode`

Current routing mode: `"off"` | `"guardrail"` | `"ai"`.

### `PUT /api/routing-mode`

Set routing mode.

```json
{ "mode": "guardrail" }
```

### `GET /api/policy`

The current automated-routing policy (cost-guardrail knobs: cheap task types, light-model targets, mode).

### `PUT /api/policy`

Update the automated-routing policy.

> This is a different feature from `POST /api/ai-policy/regenerate` (`server/src/api/routes/aiPolicy.js`), which regenerates the AI-routing task→model assignment map using the connected providers. `/api/policy` only holds the guardrail-mode knobs above.

---

## Analytics

### `GET /api/analytics/overview`

Aggregated cost, token, and request counts. Includes `cacheHitRate`, `cachedReadTokens`, `cacheSavingUsd` — prompt-cache observability. Realised savings from model substitutions is a separate metric, not part of this response — see `GET /api/analytics/realised-savings` below.

### `GET /api/analytics/by/:dimension`

Breakdown by `application`, `team`, `workflow`, `model`, `provider`, `taskType`, or `user` — `dimension` is a path segment, e.g. `/api/analytics/by/user?from=2024-01-01`. `team` groups by the underlying `department` field. Null `userId` groups as `(unattributed)`.

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

### `POST /api/recommendations/:id/dismiss`

Dismiss a recommendation.

---

## Provider connections

### `GET /api/connections`

List all providers with their connection status and default model.

### `PUT /api/connections/:provider`

Store or update a provider credential (encrypted at rest).

### `DELETE /api/connections/:provider`

Remove a stored credential (falls back to env var if set).

### `POST /api/connections/:provider/test`

Make a live test call to the provider using its currently effective credential.

### `PUT /api/default-provider`

Set the default provider used when a request names none.

```json
{ "provider": "openai" }
```

### `PUT /api/default-model`

Set the default model (applies to the default provider; used in auto mode).

```json
{ "model": "gpt-4o-mini" }
```

### `POST /api/secrets/refresh`

Administrator only. Re-resolves every credential-shaped env var (picks up a rotated
cloud secret-manager value with no restart) and invalidates the connections cache.
Never returns a value.

```json
{ "resolved": 3, "failures": [] }
```

## Operational readiness

### `GET /health/ready`

Public, no auth. Readiness — distinct from `GET /health` above. See
[Operational readiness](/operational-readiness).

### `GET /api/ops/export`

Administrator only. Exports `Settings`, `Rule`, and `Cap` documents as one JSON object.
Never includes provider credentials — that collection isn't queried.

### `POST /api/ops/import`

Administrator only. Restores a previously exported bundle. Creates fresh documents (not
an ID-preserving merge); Settings fields are applied from a schema-derived allowlist, not
a raw merge of the request body.

### `POST /api/ops/support-bundle`

Administrator only. Returns a diagnostics bundle — version/config summary, current
Settings, disk usage, 24h request/error-rate counts, and the last 50 audit-log entries
(projected to a fixed field list). Never includes credentials or captured request/response
content — see [Operational readiness](/operational-readiness) for exactly what's excluded
and why.
