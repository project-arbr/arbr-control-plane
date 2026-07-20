# Model registry

The model registry maps model IDs to pricing (USD / 1M tokens) and tier. It's backed by MongoDB and editable at runtime — no code changes, no restart.

## What the registry drives

| Feature | With a registry entry | Without (pass-through) |
|---|---|---|
| Cost tracking | ✅ per call | `totalCost: $0` |
| Recommendations | ✅ premium overuse flagged | ✅ partially (for known models) |
| Guardrail downgrade | ✅ | ✅ (if the target model is registered) |
| Routing / gateway | ✅ | ✅ (pass-through always works) |

You can route to **any model on any live provider** without a registry entry. Entries are only needed for accurate cost tracking and tier-aware recommendations.

## Model catalog (LiteLLM sync)

There's no static seed list — LiteLLM's public model catalog is the single source of truth for what's in the registry:

- **Fresh install (empty registry):** on boot, Arbr automatically runs a LiteLLM sync so the registry isn't empty on first start.
- **Existing install:** legacy `builtIn: true` entries are converted to `builtIn: false` at boot, so sync can manage (refresh pricing on, and eventually clean up) models that used to be hardcoded.
- **Ongoing:** sync discovers new chat models from LiteLLM's catalog, refreshes pricing/context-window/capability flags on every existing model, and removes models that have fallen out of the upstream catalog (only for entries not marked `builtIn`). Sync never touches `tier`, `label`, `builtIn`, or `enabled` — once you set those, Arbr won't overwrite them.

See [Refreshing the catalog](#refreshing-the-catalog) below for how to trigger a sync manually.

The tables below are a snapshot of a freshly-synced catalog — exact models and prices drift as LiteLLM's upstream catalog changes. Check **Models** in the dashboard for what's actually registered.

### Anthropic

| Model ID | Label | Tier | Input $/1M | Output $/1M |
|---|---|---|---|---|
| `claude-opus-4-8` | Claude Opus 4.8 | premium | $5.00 | $25.00 |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 | mid | $3.00 | $15.00 |
| `claude-haiku-4-5` | Claude Haiku 4.5 | light | $1.00 | $5.00 |

### OpenAI

| Model ID | Label | Tier | Input $/1M | Output $/1M |
|---|---|---|---|---|
| `gpt-4o` | GPT-4o | premium | $2.50 | $10.00 |
| `gpt-4o-mini` | GPT-4o Mini | light | $0.15 | $0.60 |

### Google Gemini

| Model ID | Label | Tier | Input $/1M | Output $/1M |
|---|---|---|---|---|
| `gemini-2.5-pro` | Gemini 2.5 Pro | premium | $1.25 | $10.00 |
| `gemini-2.5-flash` | Gemini 2.5 Flash | light | $0.30 | $2.50 |
| `gemini-2.5-flash-lite` | Gemini 2.5 Flash Lite | light | $0.10 | $0.40 |

### Amazon Bedrock — Nova

| Model ID | Label | Tier | Input $/1M | Output $/1M |
|---|---|---|---|---|
| `us.amazon.nova-pro-v1:0` | Nova Pro | mid | $0.80 | $3.20 |
| `us.amazon.nova-lite-v1:0` | Nova Lite | light | $0.06 | $0.24 |
| `us.amazon.nova-micro-v1:0` | Nova Micro | light | $0.035 | $0.14 |

### Amazon Bedrock — cross-inference

| Model ID | Label | Tier | Input $/1M | Output $/1M |
|---|---|---|---|---|
| `zai.glm-5` | GLM-5 | mid | $1.00 | $3.20 |
| `moonshotai.kimi-k2.5` | Kimi K2.5 | mid | $0.60 | $3.00 |
| `qwen.qwen3-next-80b-a3b-instruct` | Qwen3 Next | light | $0.50 | $1.20 |
| `deepseek.v3.2` | DeepSeek V3.2 | light | $0.62 | $1.85 |
| `us.deepseek.r1-v1:0` | DeepSeek R1 | premium | $1.35 | $5.40 |
| `google.gemma-3-12b-it` | Gemma 3 12B | light | $0.09 | $0.29 |
| `anthropic.claude-3-5-sonnet-20241022-v2:0` | Claude 3.5 Sonnet (Bedrock) | premium | $3.00 | $15.00 |
| `meta.llama3-70b-instruct-v1:0` | Llama 3 70B | mid | $0.99 | $0.99 |
| `meta.llama3-8b-instruct-v1:0` | Llama 3 8B | light | $0.22 | $0.22 |

### DeepSeek (direct API)

| Model ID | Label | Tier | Input $/1M | Output $/1M |
|---|---|---|---|---|
| `deepseek-chat` | DeepSeek Chat | light | $0.27 | $1.10 |
| `deepseek-reasoner` | DeepSeek Reasoner | premium | $0.55 | $2.19 |

### Moonshot AI

| Model ID | Label | Tier | Input $/1M | Output $/1M |
|---|---|---|---|---|
| `moonshot-v1-8k` | Moonshot 8K | light | $0.12 | $0.12 |
| `moonshot-v1-32k` | Moonshot 32K | mid | $0.24 | $0.24 |
| `moonshot-v1-128k` | Moonshot 128K | premium | $0.82 | $0.82 |

### xAI (Grok)

| Model ID | Label | Tier | Input $/1M | Output $/1M |
|---|---|---|---|---|
| `grok-3` | Grok 3 | premium | $3.00 | $15.00 |
| `grok-3-mini` | Grok 3 Mini | light | $0.30 | $0.50 |

### Groq

| Model ID | Label | Tier | Input $/1M | Output $/1M |
|---|---|---|---|---|
| `llama-3.3-70b-versatile` | Llama 3.3 70B (Groq) | mid | $0.59 | $0.79 |
| `llama-3.1-8b-instant` | Llama 3.1 8B (Groq) | light | $0.05 | $0.08 |

## Adding a model

### Dashboard (Models page)

Open a provider's card on the **Models** page and click **+ Add model**. The form has exactly three fields:
- **Model ID** — the exact string you'll send in `"model":` requests
- **Display name** (required) — human-readable label
- **Tier** — `light` / `mid` / `premium`

There's no separate Provider field — the form lives inside that provider's card, so the provider is implicit. There's also no manual pricing field: if the Model ID matches an entry already in the registry (e.g. discovered by a LiteLLM sync), pricing and metadata auto-fill; otherwise pricing defaults to **$0** and must be corrected afterward via `PATCH /api/models/:id`.

### Admin API

```sh
# Create
curl -X POST http://localhost:4100/api/models \
  -H 'Content-Type: application/json' \
  -d '{
    "id": "my-model-v2",
    "provider": "openai",
    "label": "My Fine-tuned Model",
    "tier": "mid",
    "inputPer1M": 2.0,
    "outputPer1M": 8.0
  }'

# Update pricing
curl -X PATCH http://localhost:4100/api/models/my-model-v2 \
  -H 'Content-Type: application/json' \
  -d '{ "inputPer1M": 1.8, "outputPer1M": 7.0 }'

# Delete (custom models only; built-ins: use enabled=false)
curl -X DELETE http://localhost:4100/api/models/my-model-v2
```

### Refreshing the catalog

To pull the latest models and pricing from LiteLLM:

- **Dashboard** — Models page → **Sync Models** button (calls `POST /api/benchmarks/sync`, which also refreshes recommendation benchmarks)
- **Admin API** — `POST /api/litellm/sync` to refresh just the model catalog

## How sync manages the registry

| Step | What happens |
|---|---|
| Discover | Any chat model in LiteLLM's catalog not already in the registry is inserted with `builtIn: false` |
| Refresh | Pricing, context window, and capability flags are updated on **every** existing model, built-in or not. `tier`, `label`, `builtIn`, and `enabled` are never touched by sync |
| Cleanup | Models no longer present in the LiteLLM catalog are deleted — but only entries with `builtIn: false` |

Built-in models can be **disabled** (toggle in Settings → Models) but not deleted. Custom/synced models can be deleted.
