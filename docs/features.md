# Arbr — Feature Reference

Complete inventory of every capability in the Arbr AI control plane. For depth on any area, follow the linked docs.

---

## Gateway endpoints

All endpoints share the same auth, routing, logging, and budget enforcement.

| Endpoint | Protocol | Description |
|---|---|---|
| `POST /v1/chat` | HTTP | Arbr-native — accepts business metadata, returns routing decision + text |
| `POST /v1/chat/completions` | HTTP + SSE | OpenAI-compatible — drop-in for any OpenAI SDK or chat UI |
| `POST /v1/embeddings` | HTTP | OpenAI-compatible embeddings — works with OpenAI and Gemini models |
| `GET /v1/realtime` | WebSocket | Transparent proxy to OpenAI Realtime API with auth injection + session logging |

### Native endpoint (`POST /v1/chat`)

- Accepts `application`, `workflow`, `department`, `userId` metadata per call
- Full routing: rules, budgets, caching, automated policies
- Returns `routingDecision`, `model`, `modelRequested`, `classifiedBy`, `cacheHit`, token usage
- Pass-through to any model string on any live provider, even if unregistered

See [Native endpoint](/gateway/native).

### OpenAI-compatible endpoint (`POST /v1/chat/completions`)

- Drop-in base URL replacement for any OpenAI SDK, LangChain `ChatOpenAI`, LibreChat, OpenWebUI, OpenCode, and more
- SSE streaming (`"stream": true`) with real token-by-token delivery, no buffering
- Routes through the same routing stack as `/v1/chat`
- Application attributed from the gateway API key

See [OpenAI-compat endpoint](/gateway/openai-compat), [Streaming](/gateway/streaming).

### Embeddings (`POST /v1/embeddings`)

- OpenAI-compatible request/response shape (`object: "embedding"`)
- Providers: OpenAI (`text-embedding-3-*`) and Gemini (`text-embedding-004`)
- Supports `input` as a string or array of strings
- Logged to RequestRecord as `taskType: "embedding"` with token counts and cost

### Realtime voice proxy (`WS /v1/realtime`)

- Bidirectional WebSocket proxy to OpenAI Realtime API (`wss://api.openai.com/v1/realtime`)
- Arbr injects the real provider API key; clients authenticate with a gateway key only
- Relays all frames without modification — tool calls, audio deltas, events
- On session close, logs `audioInputTokens`, `audioOutputTokens`, `textInputTokens`, `textOutputTokens`, `sessionDurationMs` to RequestRecord

---

## Providers

Connect any combination — all providers share the same routing, logging, and budget layer.

| Provider | Key | Notes |
|---|---|---|
| **Anthropic** | `anthropic` | Claude Opus/Sonnet/Haiku; prompt-cache token tracking |
| **OpenAI** | `openai` | GPT-4o, GPT-4o Mini; also accepts a custom `baseURL` for LiteLLM |
| **Google Gemini** | `gemini` | Gemini 2.5 Pro/Flash/Flash-Lite; prompt-cache token tracking |
| **Amazon Bedrock** | `bedrock-nova` | Nova Pro/Lite/Micro and cross-inference models; AWS credential-based |
| **DeepSeek** | `deepseek` | DeepSeek Chat and Reasoner |
| **Moonshot AI** | `moonshot` | Moonshot 8K/32K/128K |
| **xAI (Grok)** | `xai` | Grok 3 and Grok 3 Mini |
| **Groq** | `groq` | Llama 3 models at inference speed |
| **Any LiteLLM proxy** | `openai` (custom base URL) | Hundreds of additional models through a LiteLLM instance |

Provider keys are stored encrypted server-side via dotenvx. They never appear in responses.

See [Providers](/providers/overview) and individual provider pages.

---

## Routing

The routing layer sits between every request and the provider. Precedence is fixed and deterministic:

| Priority | Condition | Tag |
|---|---|---|
| 1 | Budget **Block** cap breached → reject 429 | `budget` |
| 2 | Budget **Downgrade** cap breached → force light-tier model | `budget` |
| 3 | Developer pinned a specific model → used as-is, all policies skip | `explicit` |
| 4a | `model: "auto"` — cache hit | `cache` |
| 4b | `model: "auto"` — first matching human routing rule | `rule` |
| 4c | `model: "auto"` — automated routing policy (cost guardrail or AI) | `auto` / `ai` |
| 4d | `model: "auto"` — default provider + model | `passthrough` |
| 5 | Provider error → retry other live providers | `fallback` |

### Routing modes

Set in Settings → Routing → Automated routing:

- **Off** — rules + default model only
- **Cost guardrail** — downgrades premium models on cheap task types automatically
- **AI routing** — AI-generated `{taskType → model}` map, editable and reviewable before activation

### Human routing rules

Created in Settings → Routing rules or accepted from Recommendations. Each rule matches on `taskType`, `application`, `workflow`, `department`, or `userId` and routes to a specific provider + model. Rules are off by default when created from a recommendation — a human must enable them.

### Task classification

When `taskType` is not provided, Arbr infers it from the latest user turn:

- **Keyword match** — rule-based, zero latency
- **AI classify** — used when AI routing mode is on and no keyword match

Known cheap types: `classification`, `extraction`, `summarisation`, `translation`, `faq`, `support response`.

Every request records `classifiedBy`, `difficulty` (1–10 score), and `confidence` (0–1).

### Difficulty-aware routing

Within a task type, difficulty score adjusts the model pick:

- **Easy (≤ 3)** → cheaper model in the tier
- **Normal (4–7)** → policy default
- **Hard (≥ 8)** → stronger model in the tier

Low-confidence results (< 0.5) do not drive routing changes.

### Routing explainability

Every `RequestRecord` includes a `routingExplain` object: which rule matched, which policy entry fired, whether a difficulty adjustment overrode the default, and which fallback was taken. Visible in the Requests drilldown.

See [Routing](/routing).

---

## Response caching

- Identical `(served_model, messages)` → returns the stored response instantly
- `routingDecision: "cache"` in the response
- `cacheHit: true` on the RequestRecord; cache hit rate tracked in the overview dashboard

---

## Model registry

- 29 built-in models seeded automatically, covering all eight providers
- Custom models addable at runtime via dashboard (Settings → Models) or Admin API
- Each entry: model ID, provider, label, tier (`light` / `mid` / `premium`), input $/1M, output $/1M
- Pass-through to unregistered models always works — cost logged as `$0` until a pricing entry exists
- Built-in models are updated by re-seeding; custom models are never overwritten by seed runs

See [Model registry](/models).

---

## Observability

### Per-request logging

Every call — all endpoints — writes one `RequestRecord` to MongoDB:

```
requestId, timestamp
application, workflow, userId, department
provider, model, modelRequested, taskType
promptTokens, completionTokens, totalTokens
audioInputTokens, audioOutputTokens (realtime only)
sessionDurationMs (realtime only)
inputCost, outputCost, totalCost
latencyMs, ttftMs, gatewayOverheadMs
status, routingDecision, classifiedBy
difficulty, difficultyScore, confidence
cacheHit, cachedReadTokens, cacheWriteTokens, cacheSavingUsd
knownPricing, routingExplain
```

### Dashboard views

| View | What it shows |
|---|---|
| **Overview** | Total requests, cost, avg latency, cache hit rate, realised savings from routing, provider prompt-cache savings |
| **Requests** | Full request log — filterable by date, app, model, provider, task type, status; click any row for drilldown |
| **Applications** | Per-app cost, requests, success rate, avg latency; health signal, kill switch per app |
| **Models** | Spend and request count by model |
| **Providers** | Spend, tokens, and 24h error rate + latency per provider |
| **Teams** | Spend and requests by department |
| **Workflows** | Spend and requests by workflow |
| **Users** | Per-user spend and request count |
| **Recommendations** | Premium-model overuse flagged with dollar saving; accept to create a routing rule |

### Attribution dimensions

Requests can carry: `application`, `workflow`, `department`, `userId`. On the OpenAI-compat endpoint, `application` is inferred from the gateway API key.

### Time-series

Daily or hourly trend charts for requests, cost, and failures over any date range.

### Provider health

24h error rate and average latency per provider — surfaces degraded connections before they affect routing.

### Realised savings

Tracks requests where a cheaper model was served instead of the one requested. Re-prices the served tokens at the requested model's rate to compute the actual saving. Visible in the Overview.

---

## Governance

### API key authentication

- Gateway keys (`ab_…`) authenticate data-plane calls and carry attribution
- Created in Settings → API keys; raw key shown **once** (SHA-256 hash stored server-side)
- Per-key **rate limit (RPM)** — returns 429 `rate_limited` when exceeded
- **Require API keys** toggle — when on, anonymous calls are rejected

### Budgets (cost caps)

Scoped by `application`, `provider`, `department`, `workflow`, `model`, or global. Rolling `day` or `month` window.

| Action | Effect |
|---|---|
| **Alert** | Cap appears as breached in dashboard and `/api/status`; requests unaffected |
| **Downgrade** | All requests in the capped scope forced to the provider's light-tier model |
| **Block** | Requests in the capped scope rejected with 429 `budget_exceeded` |

Downgrade and Block outrank explicit developer model pins.

### Application kill switch

Per-application kill switch in the Applications dashboard — disables all requests from an application instantly without deleting its key or config.

### Admin key

`ARBR_ADMIN_KEY` gates the dashboard and all `/api/*` admin routes. Unset = open (local dev only). Set before exposing beyond localhost.

See [Budgets & governance](/budgets).

---

## SDKs

### JavaScript — `arbr-client`

```sh
npm install arbr-client
```

- `client.chat(opts)` — native endpoint call with routing metadata in response
- `client.stream(opts)` — buffered streaming, yields chunks after the full call
- `client.embeddings(opts)` — single or batch text embeddings
- Configurable `timeoutMs`, `retries` (exponential backoff + jitter), injectable `fetch`
- TypeScript types included (`index.d.ts`)

### Python — `arbr-client`

```sh
pip install arbr-client
```

- `client.chat(messages, ...)` — sync
- `async_client.chat(messages, ...)` — async
- `client.embeddings(input, *, model, ...)` — single or batch
- Retry and timeout support; no third-party dependencies

See [JS SDK](/sdk/js), [Python SDK](/sdk/python).

---

## Integrations

- **LibreChat** — set base URL + gateway key; full chat UI routed through Arbr
- **OpenCode** — terminal AI coding agent; register Arbr as a custom OpenAI-compatible provider
- **NVIDIA NIM** — connect NIM-hosted models via the OpenAI-compat endpoint
- **LangChain** — `ChatOpenAI` pointed at Arbr base URL, no other changes
- **Any OpenAI SDK** — Python, Node.js, Go, Ruby — change `base_url` only

See [Integrations](/integrations/librechat), [OpenCode](/integrations/opencode).

---

## Deployment

- Node.js + Express server; MongoDB for storage
- Single Docker container or bare-metal; no external queue or cache required
- `dotenvx`-encrypted `.env` — provider keys encrypted at rest in the repo
- GCP deployment guide included (Cloud Run + Atlas)
- Configurable via env vars: port, host, default model, max tokens, RPM limits, caching toggle

See [Deployment](/deployment), [GCP deployment](/deployment-gcp), [Configuration](/configuration).
