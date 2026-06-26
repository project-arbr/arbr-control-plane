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

1. Connect to MongoDB (`config.mongoUri`).
2. `registry.init()` — seed the `ModelEntry` baseline if empty, warm the in-memory model cache.
3. Mount routes: the gateway (`/v1/chat`, `/v1/chat/completions`), discovery
   (`/v1/models`, `/v1/providers`, `/v1/task-types`), the admin API (`/api/*`, master-key
   gated), and the static dashboard.
4. Start a daily purge of `RequestRecord`s past the retention window, then `listen`.

## Request lifecycle

The path of one gateway request (`server/src/gateway/handler.js`, `openaiCompat.js`):

1. **Ingress + auth** — `auth.middleware` validates the API key (when required), binds
   attribution (application / workflow / user), and enforces per-key rate limits.
2. **Resolve route** — routing precedence honors the developer's explicit choice:
   1. An explicit, available model is used **as-is**, skipping all policy.
   2. Otherwise (`model: "auto"`, absent, or the requested provider isn't connected) the
      router decides: **cache → rules → automated routing (cost guardrail / AI policy) →
      default**, with fallback to another live provider on error.
3. **Classify task** — `classify/classifier.js` tags the request's task type
   (`provided` | `keyword` | `ai`), which feeds the routing policy.
4. **Enforce budget** — `routing/capEngine.js` may block (429) or downgrade to a cheaper
   model when a cap is breached.
5. **Dispatch** — OpenAI-compatible providers (openai/deepseek/moonshot/xai/groq/litellm)
   are reverse-proxied raw, preserving tools/vision/streaming; native providers
   (anthropic/gemini/bedrock-nova) go through the LangChain factory.
6. **Respond, then log** — the response is returned first; `logging/logger.js` writes one
   `RequestRecord` asynchronously (cost computed from the pricing registry).

## Where things live

```
server/src/
  index.js          boot: mongo → registry.init() → mount routes → listen
  config.js         env-driven config + demo-mode detection
  gateway/          /v1 request handling
    handler.js        native /v1/chat: resolveRoute + invokeWithFallback
    openaiCompat.js   OpenAI-compatible /v1/chat/completions (raw proxy + native paths)
    auth.js           data-plane API-key auth, attribution, rate limits
    capabilities.js   per-provider/model tool-call support
  routing/          ruleEngine · autoRouter · aiPolicy (scoring engine) · capEngine · cache
  classify/         task-type classification (provided / keyword / AI)
  providers/
    llm-router/       vendored LangChain factory unifying provider adapters
    connections.js    which providers are "live" (have credentials)
  pricing/          cost registry + pricing table
  litellm/ lmsys/ livebench/   catalog + benchmark-score sync jobs (manual / on-demand)
  security/secrets.js   AES-256-GCM encryption of provider keys at rest
  maintenance/purge.js  retention purge of old request records
  api/routes.js     dashboard / admin REST API (master-key gated)
  models/           Mongoose schemas (see below)
web/src/            React + Vite + Tailwind dashboard (api.js → /api)
clients/            JS and Python SDKs (published separately)
docs/               VitePress documentation site
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
| `Rule` | Human-approved routing rules |
| `Recommendation` | Costed optimization suggestions |
| `ApplicationConfig` | Per-application routing policy |
| `CustomProvider` | User-added OpenAI-compatible providers |
| `AuditLog` | Governance audit trail |

## Key concepts

- **Demo mode** — with no provider keys set, the app runs on seeded data so every dashboard
  works out of the box. Adding a key unlocks live gateway calls for that provider.
- **Live providers** — `providers/connections.js` computes the set of providers that
  currently have credentials; discovery endpoints and the router only surface those.
- **Keys at rest** — provider credentials are encrypted with `ARBR_ENCRYPTION_KEY`
  (`security/secrets.js`); the server refuses to boot in production without it.
- **Catalog sync** — `litellm/sync.js` imports the full LiteLLM model catalog; `livebench`
  and `lmsys` add benchmark scores. These are on-demand (the dashboard "Sync Models" button
  → `POST /api/benchmarks/sync`), not run on boot.
