# Gateway overview

Arbr exposes two endpoints — an Arbr-native API and an OpenAI-compatible API. Both share the same routing, budgets, and logging. Your app picks whichever fits its existing code.

## Request flow

```
Applications ──▶ POST /v1/chat              ──▶ auth ──▶ route ──▶ invoke ──▶ respond
                 POST /v1/chat/completions        │        │         │
                 (OpenAI-compat, SSE)             │        │         └── provider call (+ fallback)
                                                  │        └── pinned model? budget? cache? rule? auto?
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

The model a developer explicitly pins is honored as-is. Routing only applies when the app says `"auto"` or omits the model:

| Priority | What | Tag |
|---|---|---|
| 1 | **Budget enforcement** — `block` rejects (429); `downgrade` forces the light model | `budget` |
| 2 | **Explicit pin** — connected model specified → used as-is, all policies skipped | `explicit` |
| 3a | **Cache** — identical messages + model → cached response | `cache` |
| 3b | **Human routing rules** — first matching enabled rule | `rule` |
| 3c | **Automated routing** — cost guardrail or AI policy (if enabled) | `auto` / `ai` |
| 3d | **Default** — configured default provider + model | `passthrough` |
| 4 | **Fallback** — on provider error, try other live providers | `fallback` |

See [Routing](/routing) for the full breakdown.

## Authentication

- **Gateway API keys** (`ab_…`) authenticate data-plane calls (`POST /v1/chat*`). Create them in **Settings → API keys**. Anonymous calls are accepted until you flip **Require API keys** on.
- **Admin key** (`ARBR_ADMIN_KEY`) gates the dashboard and admin API. Unset = open (local dev only).

See [Deployment](/deployment) for the two-key model in production.
