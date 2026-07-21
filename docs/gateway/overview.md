# Gateway overview

Arbr exposes two endpoints — an Arbr-native API and an OpenAI-compatible API. Both share the same routing, budgets, and logging. Your app picks whichever fits its existing code.

## Request flow

```
Applications ──▶ POST /v1/chat              ──▶ auth ──▶ route ──▶ invoke ──▶ respond
                 POST /v1/chat/completions        │        │         │
                 (OpenAI-compat, SSE)             │        │         └── provider call (+ fallback)
                                                  │        └── pinned model? rule? auto? → then budget → then cache?
                                                  └── validate API key, capture metadata
                                                                         │
                                         after response (async): classify · cost · log RequestRecord
```

## The two endpoints

| | `POST /v1/chat` | `POST /v1/chat/completions` |
|---|---|---|
| Format | Arbr-native JSON | OpenAI-compatible JSON |
| Routing | Full — rules, budgets, caching | Full — same routing logic |
| Attribution fields | `application`, `workflow`, `department`, `userId` | Maps `application` from API key; `workflow: "completion"` |
| Streaming | Not supported | ✅ SSE (`"stream": true`) |
| Response shape | Arbr `ChatResponse` | OpenAI `chat.completion` |
| Use when | Your app sends business metadata with each call | Swapping a base URL in an existing OpenAI-based app |

## What gets logged

Every call — both endpoints — writes one `RequestRecord` to MongoDB:

```
requestId, timestamp
application, workflow, userId, department
provider, model, modelRequested, taskType
promptTokens, completionTokens, totalTokens
inputCost, outputCost, totalCost
latencyMs, status, routingDecision, cacheHit
```

Both the model **requested** and the model **served** are recorded — so realized savings from routing rules are always measurable.

## Routing precedence

Routing fully decides *which model gets served* before budgets or caching ever run. The model a developer explicitly pins is honored as-is; routing tiers below only apply when the app says `"auto"` or omits the model:

| Priority | What | Tag |
|---|---|---|
| 1 | **Explicit pin** — connected model specified → used as-is, all policy tiers below skipped | `explicit` |
| 2 | **Human routing rules** — first matching enabled rule | `rule` |
| 3 | **Automated routing** — cost guardrail or AI policy (if enabled) | `auto` / `ai` |
| 4 | **Default** — configured default provider + model | `passthrough` |
| 5 | **Canary** — an eval-approved candidate diverts a % of AUTO-routed traffic (never touches an explicit pin) | `canary` |

Once a model is decided, two more steps can still change what happens — but neither is a competing *routing* tier:

- **Budget enforcement** runs next, against the resolved model. A breached `block` cap rejects the request (429); a breached `downgrade` cap forces the provider's light model — this overrides even an explicit pin, since enforcement is meant to hold no matter what was requested.
- **Response cache lookup runs last**, keyed on the already-decided served model. It's a "skip the provider call" shortcut, not an earlier-ranked tier: if an identical prompt was already answered for that exact model, Arbr returns the cached text instead of invoking the provider (tagged `cache`, or `semantic_cache` for an embedding-similarity match).

**Fallback** — if the provider call itself fails, Arbr retries on another live provider/model (tagged `fallback`).

See [Routing](/routing) for the full breakdown.

## Authentication

- **Gateway API keys** (`ab_…`) authenticate data-plane calls (`POST /v1/chat*`). Create them in **Settings → API keys**. Anonymous calls are accepted until you flip **Require API keys** on.
- **Admin key** (`ARBR_ADMIN_KEY`) gates the dashboard and admin API. Unset = open (local dev only).
- In production, a second identity layer — OIDC login or a trusted reverse-proxy header — can also gate the admin API, independent of whether `ARBR_ADMIN_KEY` is set: either a valid session/header or the admin key grants access. See [Authentication](/auth) for the full setup.

See [Deployment](/deployment) for the two-key model in production.
