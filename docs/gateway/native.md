# Native endpoint — POST /v1/chat

The Arbr-native endpoint. Accepts business metadata alongside messages for full attribution, task classification, and routing.

## Request

```http
POST /v1/chat
Content-Type: application/json
Authorization: Bearer ab_…   (optional until Require API keys is on)
```

### Body fields

| Field | Type | Required | Description |
|---|---|---|---|
| `messages` | string \| array | ✅ | A bare string (→ one user message), `{role, content}` objects, or LangChain message objects |
| `application` | string | | Attribution — the app or service making the call. Shows in all dashboard views. |
| `workflow` | string | | Sub-workflow within the app (e.g. `"ticket-triage"`, `"answer-drafting"`) |
| `department` | string | | Team or department attribution |
| `userId` | string | | End-user identifier |
| `taskType` | string | | One of the known task types (classification, extraction, summarisation, …). Auto-inferred if omitted. |
| `model` | string | | Model ID to use, or `"auto"` / omit to let the router decide |
| `provider` | string | | Provider ID (`openai`, `anthropic`, `gemini`, `bedrock-nova`, `deepseek`, `moonshot`, `xai`, `groq`). Required for pass-through to an unregistered model. |
| `temperature` | number | | Sampling temperature (0–2) |
| `maxTokens` | number | | Max completion tokens |

### Full example

```sh
curl -X POST http://localhost:4100/v1/chat \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer ab_…' \
  -d '{
    "application": "support-chat",
    "workflow": "ticket-triage",
    "department": "Support",
    "userId": "u-123",
    "taskType": "classification",
    "model": "claude-haiku-4-5",
    "provider": "anthropic",
    "messages": [
      { "role": "system", "content": "Classify the support ticket in one word." },
      { "role": "user",   "content": "My card was declined at checkout." }
    ],
    "maxTokens": 50
  }'
```

## Response

```json
{
  "requestId": "a1b2c3d4-...",
  "text": "billing",
  "model": "claude-haiku-4-5",
  "modelRequested": "claude-haiku-4-5",
  "provider": "anthropic",
  "routingDecision": "explicit",
  "classifiedBy": "provided",
  "cacheHit": false,
  "usage": {
    "inputTokens": 28,
    "outputTokens": 1,
    "totalTokens": 29,
    "cachedReadTokens": 0,
    "cacheWriteTokens": 0
  }
}
```

### Response fields

| Field | Description |
|---|---|
| `requestId` | UUID for this call — use it to correlate with the Requests log |
| `text` | The model's completion |
| `model` | Model that actually served the response |
| `modelRequested` | Model you asked for (`"auto"` when you deferred) |
| `provider` | Provider that served the response |
| `routingDecision` | `explicit` \| `passthrough` \| `rule` \| `auto` \| `ai` \| `cache` \| `fallback` \| `budget` |
| `classifiedBy` | How `taskType` was determined: `provided` \| `keyword` \| `ai` |
| `cacheHit` | Whether the response was served from Arbr's response cache |
| `usage.inputTokens` | Total prompt tokens (includes any cached tokens) |
| `usage.outputTokens` | Completion tokens |
| `usage.totalTokens` | Total tokens |
| `usage.cachedReadTokens` | Prompt tokens served from the provider's prompt cache (billed at cache-read rate) |
| `usage.cacheWriteTokens` | Prompt tokens written to the provider's prompt cache (billed at cache-write rate) |

**Fields logged but not returned to the caller** (visible in the Requests drilldown):
`difficulty`, `difficultyScore`, `confidence`, `routingExplain`, `cacheSavingUsd`, `messages`, `responseText`.

## Pass-through routing

You can route to any model ID on a live provider even if it's not in the model registry — just supply both `provider` and `model`:

```sh
curl -X POST http://localhost:4100/v1/chat \
  -H 'Content-Type: application/json' \
  -d '{
    "provider": "openai",
    "model": "o3-mini",
    "messages": "Draft a 3-sentence product update email."
  }'
```

Cost is logged as `$0` until you add a pricing entry for the model in **Settings → Models**.

## Error responses

| Status | `error` field | Meaning |
|---|---|---|
| 400 | `invalid_request` | Missing or malformed fields |
| 401 | `invalid_api_key` | Missing/unknown gateway API key when Require API keys is on |
| 429 | `budget_exceeded` | A `block` budget cap is breached |
| 429 | `rate_limited` | Per-key RPM limit hit |
| 502 | `provider_error` | All providers failed |
| 503 | `demo_mode` | No provider keys configured |
