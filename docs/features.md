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

Dashboard-stored provider keys are encrypted at rest (AES-256-GCM, under `ARBR_ENCRYPTION_KEY`) and never appear in responses. A key can also be set as an env var directly, or point at a reference in a cloud secret manager instead of a literal value — see [Cloud secret-manager integration](#cloud-secret-manager-integration) below.

See [Providers](/providers/overview) and individual provider pages.

---

## Routing

The routing layer sits between every request and the provider. Precedence is fixed and deterministic:

| Priority | Condition | Tag |
|---|---|---|
| 1 | Developer pinned a specific model → used as-is, all routing policy skips | `explicit` |
| 1b | `model: "auto"` (or omitted) → first matching human routing rule | `rule` |
| 1c | `model: "auto"` → automated routing policy (cost guardrail or AI), with an eval-approved canary experiment able to divert a fraction of this auto-routed traffic | `auto` / `ai` / `canary` |
| 1d | `model: "auto"` → default provider + model | `passthrough` |
| 2 | Budget **Block** cap breached → reject 429. Budget **Downgrade** cap breached → force the light-tier model. **This outranks everything above, including an explicit pin** — that is the point of enforcement. | `budget` |
| 3 | Exact-match cache hit, then (if enabled) semantic cache hit — checked against whatever model survived steps 1-2, for any request | `cache` / `semantic_cache` |
| 4 | Provider error → retry other live providers per `ARBR_FALLBACK_SCOPE` | `fallback` |

Priority 1c's canary diversion never touches an explicit pin (step 1) — only auto-routed
traffic is eligible. Priority 2's budget enforcement is checked against whatever model was
decided in step 1, and can override even a developer's pin.

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

## Recommendations

Arbr watches real traffic and surfaces where a cheaper model would handle the same work.

- **Overspend detection** — flags `(application, taskType, model, provider)` groups where a
  premium-tier model is handling a task type marked "cheap," with a minimum request count
  before a group qualifies
- **Scoped or org-wide** — a recommendation is scoped to one application if the pattern is
  local, or org-wide if no single app qualifies alone
- **Real projected savings** — computed by re-pricing the group's actual prompt + completion
  tokens at the suggested lighter model, not estimated
- **A derived lifecycle stage, never stored** — every recommendation's stage (opportunity,
  building an eval dataset, evaluating, ready for rollout, running as a shadow campaign or
  canary, accepted and live, rolled back, dismissed) is computed fresh from its linked
  records on every read, so it can never drift from what actually happened
- **"Almost-savings" surfaced too** — a genuine saving that wasn't caught only because a
  task type isn't yet marked "cheap," with a one-click fix
- **Realised vs. projected outcome** — once a recommendation's rule is live, its actual
  measured savings, latency, and error rate are compared against what was projected

An accepted recommendation creates a **disabled** routing rule — a human always enables it.

See [Routing](/routing), [Budgets & governance](/budgets).

---

## Evaluation & guarded rollout

No cheaper model gets used until it's been tested against the org's own traffic.

### Offline replay

- Builds a test dataset from real historical requests linked to a recommendation —
  deduplicated by prompt, sampled across workflow/difficulty strata so no group dominates
- Replays a candidate model against every item, judged against the recorded production
  response by a rubric-scoring AI judge (correctness, completeness, instruction-following,
  format, safety, plus a critical-failure flag)
- The judge's position (which answer is "A" vs "B") is randomized per item to avoid
  position bias, and a same-family-model guard applies on high-risk task types so a model
  never judges a candidate from its own family
- A second, skeptical judging pass re-examines any "worse" verdict before it's allowed to
  sink a candidate
- Pass/fail bars scale with risk: higher-stakes task types need a larger sample and a
  near-zero critical-failure rate before a candidate can pass
- A recommendation only becomes an enabled rule after a passed evaluation, or an audited,
  reason-and-approver-required human override

### Shadow evaluation

- Mirrors a sampled fraction of live traffic to a candidate model in the background,
  strictly after the real response has already been served — never delays or risks the
  request a customer is waiting on
- Stops mirroring automatically if it starts costing too much (a daily budget cap) or
  erroring too often (a candidate-error auto-pause)

### Canary rollout & auto-rollback

- Diverts a deterministic percentage of **auto-routed** traffic only — an explicit pin is
  never diverted — from a baseline model to an eval-approved candidate
- A monitor recomputes error-rate delta, latency regression, and cost saving on a rolling
  window and **automatically rolls back** on any guardrail breach; a human can also roll
  back manually at any time
- A successful canary can be promoted to a permanent, fully-enabled routing rule with one
  action

### Evidence report

- `GET /api/recommendations/:id/report` assembles a complete, on-demand report for one
  recommendation — evaluation results, shadow/canary status, the full approval and audit
  history, and the realised-vs-projected outcome — as JSON or a readable Markdown document
- Self-flags its own caveats (e.g. unknown model pricing, a sample size below the risk
  tier's target) rather than presenting a false sense of certainty

### Design-partner demo fixture

- `npm run demo:seed` walks the entire story — opportunity, a passing evaluation, a live
  canary, and a guardrail-breaching canary already mid-rollback — using synthetic data fed
  through the same real aggregation/judging code as a genuine evaluation, with **no
  provider keys required**
- `npm run demo:reset` removes only this seeded data, scoped by an `isDemoFixture` flag —
  it never touches real data

See [Routing](/routing) for canary-rollout mechanics, [Design-partner demo fixture](/demo-fixture).

---

## Model registry

- On an empty install, Arbr syncs the full LiteLLM public model catalog automatically —
  thousands of models with pricing and capability flags (vision, reasoning, tool calling,
  prompt caching), no manual step required
- Re-syncable on demand from the dashboard ("Sync Models") whenever pricing changes upstream
- Custom models addable at runtime via dashboard (Settings → Models) or Admin API
- Each entry: model ID, provider, label, tier (`light` / `mid` / `premium`), input $/1M, output $/1M
- Pass-through to unregistered models always works — cost logged as `$0` until a pricing entry exists
- A sync only creates/updates catalog-sourced entries; custom, user-added models are never
  overwritten or removed by it

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

### OpenTelemetry tracing

- Exports one OTLP trace span per logged request to any standard OTel collector (Datadog,
  Jaeger, Honeycomb, and similar) — **off by default**
- Emitted from the same post-response logging path as the `RequestRecord` write, so tracing
  adds nothing to request latency and can't throw into it
- Prompt/response content is only attached to a span if explicitly enabled — never on by
  default, and length-capped when it is
- Adjustable live from the Governance page — on/off and sample ratio, no restart required
- Honors an inbound `traceparent` header, so a caller's own trace stays connected end to end

See [OpenTelemetry tracing](/opentelemetry).

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

`ARBR_ADMIN_KEY` gates the dashboard and all `/api/*` admin routes. Unset = open (local dev only). Set before exposing beyond localhost. Works as a break-glass credential in every identity mode below, not just the default one.

### Identity & access (per-user)

- Three roles — **viewer** (read-only), **operator** (day-2 actions: rotate keys, accept
  eval-gated recommendations, run evals, start canaries), **administrator** (secrets, global
  policy, user management)
- Three identity modes — the default shared admin key; **OIDC** login against any compliant
  provider (Okta, Auth0, Google Workspace, ...); **trusted-header**, for a deployment already
  sitting behind an identity-aware proxy (GCP IAP or a shared-secret header)
- Every audit entry names the real person who acted, never a generic shared string
- Users are managed from the dashboard (administrator role required); a one-time script
  mints the first administrator

See [Accountable admin access](/auth).

### Cloud secret-manager integration

- Any credential-shaped setting — a provider key, the admin key, the encryption key — can
  hold a `gcp-sm://projects/.../secrets/.../versions/...` reference instead of a literal
  value, resolved transparently at boot
- Resolved again automatically on a schedule, or immediately via an admin-only refresh
  endpoint — a rotated secret takes effect with **no restart**
- Cloud-agnostic by design: adding AWS Secrets Manager or Azure Key Vault is one new file
  against the same interface, no changes anywhere else (documented, not yet built)
- In production, a secret that fails to resolve refuses to start the server rather than
  silently falling back to an unresolved value

See [Cloud secret-manager integration](/secret-manager).

See [Budgets & governance](/budgets).

---

## Operational readiness

- **Liveness vs. readiness** — `GET /health` always answers if the process is up, never
  depends on Mongo; `GET /health/ready` reflects Mongo connectivity and a brief drain window
  after a shutdown signal, distinct from liveness so an orchestrator can stop routing traffic
  here without treating the instance as dead
- **Backup & restore** — `ops/backup.sh` / `ops/restore.sh`, with a documented
  post-restore verification checklist and disaster-recovery runbook
- **Config/policy export & import** — download every Setting, routing rule, and budget as
  one JSON file, and restore it onto a fresh instance — never includes provider credentials
- **Support-diagnostics bundle** — one admin-only call assembles version, config, disk
  usage, and recent activity for a support request, with no credentials or captured
  prompt/response content, by construction
- **Deploy safety** — a gated deploy script health-checks a new version and rolls back
  automatically on failure; it also refuses to proceed past 90% disk usage instead of
  failing mid-pull

See [Operational readiness](/operational-readiness).

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
- Single Docker container or bare-metal; no external queue or cache required (horizontal
  scale is a documented, deliberately deferred roadmap item — see [Operational
  readiness](/operational-readiness))
- Dashboard-stored provider keys are encrypted at rest in MongoDB (`ARBR_ENCRYPTION_KEY`,
  separate from `dotenvx`, which optionally encrypts the `.env` file itself on disk)
- A GCP reference deployment guide is included: a single GCE VM behind a GCP load balancer,
  self-hosted MongoDB in a container (not Cloud Run, not Atlas) — plus a generic single-VM
  guide (nginx or an AWS ALB in front) for any other cloud
- Configurable via env vars: port, host, default model, max tokens, RPM limits, caching toggle

See [Deployment](/deployment), [GCP deployment](/deployment-gcp), [Configuration](/configuration).
