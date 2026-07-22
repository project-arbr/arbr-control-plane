# Architecture

A map of how Arbr Control Plane fits together, for contributors getting oriented.
For setup and workflow see [CONTRIBUTING.md](CONTRIBUTING.md).

## What it is

A single service that sits in front of every LLM provider. Applications send all AI
requests through **one gateway**; by default it passes the request straight to the
requested provider, while logging full metadata, making spend legible, surfacing costed
recommendations, and — once a human approves — applying deterministic, reversible routing
rules. A React dashboard drives configuration; everything is backed by MongoDB.

```
  apps / SDKs ──POST /v1/chat[/completions]──▶  Gateway  ──▶  Router  ──▶  LLM providers
                                                   │              │        (OpenAI, Anthropic,
                                                   │              │         Gemini, Bedrock, …)
  dashboard  ────────/api/*────────────────▶  Admin API          │
                                                   └──────────────┴──▶  MongoDB
```

The server is single-process: in production it also serves the built dashboard on the same
port (`web/dist`), so the whole thing runs as one container.

## Boot sequence

`server/src/index.js` → `start()`:

1. `assertProductionReady()` — in production, fail closed before any network bind if
   `ARBR_ADMIN_KEY`/`ARBR_ENCRYPTION_KEY` are missing.
2. Resolve any credential-shaped env var that holds a secret-manager reference
   (`security/secretResolver.js`) — before Mongo connects or anything reads a credential.
   A no-op for a literal value; in production, a resolution failure refuses to start.
3. Connect to MongoDB (`config.mongoUri`).
4. `registry.init()` — seed the `ModelEntry` baseline if empty, warm the in-memory model cache.
5. Mount routes: the gateway (`/v1/chat`, `/v1/chat/completions`), discovery
   (`/v1/models`, `/v1/providers`, `/v1/task-types`), the admin API (`/api/*`, master-key
   gated), and the static dashboard. `GET /health` (liveness) and `GET /health/ready`
   (readiness) are mounted here too — see `health/readiness.js`.
6. Start a daily purge of `RequestRecord`s past the retention window, start the
   secret-resolver's periodic refresh, then `listen`.

## Request lifecycle

The real order in `server/src/gateway/handler.js`'s `handleChat` (shared by `openaiCompat.js`),
verified against the code, not approximated:

1. **Ingress** — validate the body, then read settings/app-config/router in parallel. Three
   early-exit checks fire here, each with no record written: maintenance mode (503), a
   per-app kill switch (503), and demo mode with no live provider (503).
2. **Input guardrails** — the max-tokens guardrail clamps `body.maxTokens` to the configured
   ceiling; prompt injection detection (`gateway/promptInjection.js`, opt-in) blocks (400)
   before any routing happens if enabled.
3. **Resolve route** (`resolveRoute`) — routing precedence honors the developer's explicit
   choice:
   1. An explicit, available model is used **as-is**, skipping all policy.
   2. Otherwise (`model: "auto"`, absent, or the requested provider isn't connected) the
      router decides: rules → automated routing (cost guardrail / AI policy) → default,
      with task classification (`classify/classifier.js`) feeding that decision. **Canary
      diversion** (`routing/canaryEngine.js`) is applied inside this same step, for
      AUTO-routed traffic only — an explicit pin is never diverted.
4. **Enforce budget** — `routing/capEngine.js` runs *after* routing, against the model
   routing just decided on. A breached enforcing cap outranks everything decided in step
   3, **including an explicit pin** — that's the point of enforcement (per the code's own
   comment at `gateway/handler.js:372-374`): block returns 429; downgrade forces the
   provider's light-tier model regardless of how the served model was originally chosen.
5. **Output-side clamp, then cache** — `pricing.clampMaxTokens` caps output to the *served*
   model's known ceiling, then the exact-match response cache
   (`routing/responseCache.js`) and, if enabled, the semantic cache
   (`routing/semanticCache.js`) are checked — both keyed on the model budget enforcement
   just settled on, not the originally-resolved one. Output guardrails apply to a cache hit
   too.
6. **Dispatch** — OpenAI-compatible providers (openai/deepseek/moonshot/xai/groq/litellm)
   are reverse-proxied raw, preserving tools/vision/streaming; native providers
   (anthropic/gemini/bedrock-nova) go through the LangChain factory.
7. **Respond, then log** — the response is returned first; `logging/logger.js` writes one
   `RequestRecord` asynchronously (cost computed from the pricing registry), and emits an
   OTel span from the same detached callback if tracing is enabled (see below).

## Where things live

```
server/src/
  index.js          boot: mongo → registry.init() → mount routes → listen; GET /health
                    (liveness) and GET /health/ready (readiness — see health/ below)
  config.js         env-driven config + demo-mode detection
  gateway/          /v1 request handling
    core.js           shared resolveRoute / fallback / headers (both entry points)
    handler.js        native /v1/chat + resolveRoute implementation
    openaiCompat.js   OpenAI-compatible /v1/chat/completions (raw proxy + native paths)
    auth.js           data-plane API-key auth, attribution, shared rate limits
    capabilities.js   per-provider/model tool-call support
    promptInjection.js  opt-in deny-list check on inbound messages
    outputGuardrail.js  opt-in deny-list check + PII masking on outbound responses
    embeddings.js     POST /v1/embeddings (Gemini + OpenAI-compat backends)
    ingest.js         POST /v1/ingest — observe-only bulk metadata ingestion
    realtimeProxy.js / wsAuth.js   POST /v1/realtime — OpenAI Realtime WebSocket proxy
  routing/          ruleEngine · autoRouter · aiPolicy (scoring engine) · capEngine · cache ·
                    canaryEngine / canaryMonitor (guarded rollout + auto-rollback) ·
                    semanticCache · errorAlertMonitor · notifier
  classify/         task-type classification (provided / keyword / AI)
  recommend/        engine.js (opportunity detection) · stage.js / stageBatch.js (derived
                    lifecycle stage) · outcome.js (realised-vs-projected) ·
                    evidenceReport.js (exportable report)
  eval/             dataset.js (from-traffic sampler) · replay.js (offline replay) ·
                    rubricJudge.js / judge.js (scoring) · shadow.js (live shadow eval) ·
                    thresholds.js (risk-tiered pass gates) · worker.js (background runner) ·
                    demoFixture.js (zero-key demo story)
  providers/
    llm-router/       vendored LangChain factory unifying provider adapters
    connections.js    which providers are "live" (have credentials)
  pricing/          cost registry + pricing table
  litellm/ lmsys/ livebench/   catalog + benchmark-score sync jobs (manual / on-demand)
  security/
    secrets.js          AES-256-GCM encryption of provider keys at rest
    secretRef.js / secretResolver.js / secretProviders/   cloud secret-manager
                        integration — resolves a `gcp-sm://...` reference transparently;
                        one new file per additional cloud (AWS/Azure documented, not built)
  internal/complete.js   the one call site for every LLM call Arbr makes for itself
                        (classification, policy generation, judging) — tagged and excluded
                        from customer-facing analytics
  health/readiness.js   pure GET /health/ready decision logic (shutting-down / Mongo state)
  telemetry/        OpenTelemetry: otel.js (OTLP export) · attributes.js (span shape,
                    redaction) · runtime.js (dashboard-adjustable sample ratio / on-off) —
                    off by default, wired from the post-response log path (see below)
  maintenance/purge.js  retention purge of old request records
  api/routes.js     thin re-export of api/routes/* domain modules (master-key gated)
  api/routes/       status, caps, keys, recommendations, evals, analytics, ops
                    (config export/import, support bundle), …
  models/           Mongoose schemas (see below)
web/src/            React + Vite + Tailwind dashboard (api.js → /api)
clients/            JS and Python SDKs (published separately)
docs/               VitePress documentation site
ops/                deploy.sh (gated, rollback-safe) · backup.sh / restore.sh
```

## Data model (MongoDB collections)

| Schema (`server/src/models/`) | Purpose |
|---|---|
| `RequestRecord` | One row per AI request — the source of every dashboard view, report, and saving |
| `ModelEntry` | The model registry: pricing, tier, capability flags (builtIn baseline + synced) |
| `ProviderCredential` | Provider API keys, **encrypted at rest** (never returned to the browser) |
| `Settings` | Singleton config + sync version markers |
| `ApiKey` | Data-plane keys, with attribution and allowed-model scoping |
| `Cap` | Budget caps (block / downgrade enforcement) |
| `CapSpend` | Atomic per-cap spend counters for hard budget enforcement |
| `Rule` | Human-approved routing rules |
| `Recommendation` | Costed optimization suggestions |
| `ApplicationConfig` | Per-application routing policy |
| `CustomProvider` | User-added OpenAI-compatible providers |
| `AuditLog` | Governance audit trail, per-user attributed |
| `User` / `Session` | Per-user identity (OIDC / trusted-header) and role, server-side sessions |
| `EvalDataset` / `EvalItem` / `EvalRun` / `EvalResult` | Offline-replay evaluation: a frozen sample of real traffic, a candidate run against it, and judged results |
| `EvalCampaign` / `EvalPair` | Shadow evaluation: live-traffic mirroring config and judged candidate-vs-baseline pairs |
| `RoutingExperiment` | A guarded canary rollout — baseline/candidate models, rollout %, guardrails, status |

## Key concepts

- **Demo mode** — with no provider keys set, the app runs on seeded data so every dashboard
  works out of the box. Adding a key unlocks live gateway calls for that provider.
- **Live providers** — `providers/connections.js` computes the set of providers that
  currently have credentials; discovery endpoints and the router only surface those.
- **Keys at rest** — provider credentials are encrypted with `ARBR_ENCRYPTION_KEY`
  (`security/secrets.js`); the server refuses to boot in production without it.
- **Catalog sync** — `litellm/sync.js` imports the full LiteLLM model catalog; `livebench`
  and `lmsys` add benchmark scores. These are on-demand (the dashboard "Sync Models" button
  → `POST /api/benchmarks/sync`), not run on boot — except once automatically on a
  fresh/empty install, where `pricing/registry.js` triggers an initial LiteLLM sync so the
  registry isn't empty on first boot.

## Operational semantics and known limitations

Being precise about what the enforcement and optimization paths actually guarantee, so
nobody mistakes a demo-grade mechanism for a hardened one. Several of these are deliberate
single-instance tradeoffs; they matter most if you run multiple replicas or high burst
traffic.

- **OTel spans are emitted from the post-response log path, not the request path.**
  When `ARBR_OTEL_ENABLED` is set, `telemetry.emit` is called from `logging/logger.js`
  inside the same detached `setImmediate` that writes the `RequestRecord`, so tracing
  adds nothing to request latency and cannot throw into it. Consequences to know:
  (a) span duration is `latencyMs`, which is provider-measured on the LangChain path and
  wall-clock on the proxy path — it is not gateway end-to-end time; (b) `ttftMs` is
  captured only on the true byte-relay streaming path, and is absent elsewhere; (c) the
  five early-return paths in `gateway/handler.js` (maintenance mode, per-app kill switch,
  demo mode) write no record and so emit no span, so a maintenance window reads as silence
  rather than errors; (d) the batch queue is per-process and in-memory, so an ungraceful
  kill loses queued spans — graceful shutdown (SIGTERM) flushes them; (e) sampling is
  head-based and per-process, though an incoming sampled `traceparent` is always honored so
  caller-initiated traces stay complete. The master switch is `ARBR_OTEL_ENABLED`, never
  `OTEL_ENABLED` (which would also flip `@langchain/core` into LangSmith-OTel mode).

- **Arbr's own AI spend is counted but never attributed to a customer.** Arbr makes LLM
  calls for itself (task classification on the routing path, AI policy generation, eval
  judging, connection/model tests). Those are real money on the customer's provider key,
  so they are stamped with `RequestRecord.internalKind` and **included in headline
  `totalCost`** — a cost dashboard that hid them would understate the actual provider bill.
  They are **excluded** from every per-application/workflow/user dimension view, from
  facets, recommendations, eval datasets, canary baselines, policy simulation, observed
  task types, provider health, and error-rate alerting, because they belong to no customer
  application. `analytics/aggregate.js` `buildMatch` is **default-deny**: a view that does
  not pass `internalScope` gets customer traffic only. Two consequences worth knowing:
  (a) a **global** cost cap counts this overhead and can therefore breach on spend the
  customer did not directly cause, while **scoped** (application/provider) caps never see
  it — `capEngine._matches`, `analytics.spend({ includeInternal })` and the Budgets page
  must stay in agreement or the displayed number diverges from the enforced one;
  (b) records written before `internalKind` existed have no such field, which query
  predicates treat as customer traffic — but **aggregation expressions do not**, so the
  internal/customer split uses `$ifNull` rather than a bare `$eq` against null.
  `RequestRecord` remains the single money ledger: eval collections (`EvalPair.prodCost`,
  `EvalRun.actualCostUsd`) intentionally re-state costs for domain reporting and are never
  summed into analytics totals.

- **Budgets use hard CapSpend counters (multi-replica safe).** `routing/capEngine.js` keeps
  per-cap atomic spend counters (`CapSpend`, Mongo `$inc`) keyed by calendar window. The
  gateway reads those counters on every request for `block`/`downgrade` caps; successful
  priced calls call `recordSpend` after logging. Soft overshoot of at most one in-flight
  request is still possible (cost is known only after the provider responds). Cap *document*
  lists are cached ~5s; spend is not. `POST /api/caps/reconcile` realigns counters from
  analytics aggregations if they drift. Only the `global`, `application`, and `provider`
  dimensions are enforced at the gateway; other dimensions surface in the UI but are not
  enforced.
- **RPM limits are multi-replica safe.** `routing/rateLimit.js` uses fixed 60s Mongo
  windows (`RateBucket` + atomic `$inc`). Falls back to in-process counters only if Mongo
  is unavailable.
- **Response cache is exact-match and ephemeral by default; near-duplicate matching is a
  separate, opt-in layer.** `routing/responseCache.js` keys on
  `sha256(model + serialized messages)`, holds at most 5,000 entries in-memory with a
  10-minute TTL, and evicts oldest-first. It does not persist across restarts, is not shared
  across replicas, and — on its own — does no semantic/near-duplicate matching. It
  demonstrates the duplicate-request saving; it is not a durable caching tier.
  `routing/semanticCache.js`, wired into `gateway/handler.js` and gated behind the
  `semanticCacheEnabled` Settings flag (default `false`), adds embedding-similarity
  matching on top: it embeds incoming messages with OpenAI `text-embedding-3-small` and
  serves a cached response when cosine similarity clears a configurable threshold (default
  `0.92`) within a configurable TTL (default 60 min). It falls back silently to the
  exact-match cache when no `OPENAI_API_KEY` is set or an embedding call fails, and shares
  the same in-memory, single-replica limitations as the exact-match cache above.
- **Output guardrails do not apply to streamed responses.** On the OpenAI-compatible
  streaming path (`gateway/openaiCompat.js`), upstream SSE bytes are relayed to the caller
  unchanged (buffering would defeat streaming). Output content guardrails and response
  transforms therefore apply to non-streaming responses only. The input-side max-tokens
  clamp still applies to both. If you rely on output guardrails, disable streaming for those
  routes.
- **PII masking is log-time, not pre-model.** `logging/piiFilter.js` masks `messages` /
  `responseText` when the `RequestRecord` is written, so it protects what is *stored*. It
  does not prevent prompts or responses from reaching the provider; it is log redaction, not
  data-loss prevention.
- **Fallback is scoped by `ARBR_FALLBACK_SCOPE`.** Default `same-provider`: on error, retry
  the same provider's default model only (no residency surprise). Set `cross-provider` for
  the legacy walk of remaining live providers, or `none` to fail closed. See
  `gateway/handler.js` (`buildFallbackOrder` / `invokeWithFallback`).
- **Recommendations price substitution; accept is quality-gated.** `recommend/engine.js`
  still re-prices tokens for suggestions, but `POST /api/recommendations/:id/accept` requires
  a passed offline eval (or an audited override). Accepted recs store `acceptedVia`; rules
  store `qualityGate` (`passed` | `overridden` | `ungated`). Dashboard
  `GET /api/analytics/savings-trust` splits projected savings by trust.
- **Production fails closed.** With `NODE_ENV=production`, boot requires `ARBR_ADMIN_KEY` and
  `ARBR_ENCRYPTION_KEY`, and forces `Settings.requireApiKey = true` so the data plane is not
  anonymous.
