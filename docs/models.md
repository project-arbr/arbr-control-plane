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

## Built-in models (29, seeded automatically)

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

Click **+ Add model** and fill in:
- **Model ID** — the exact string you'll send in `"model":` requests
- **Provider** — must match a live provider on the Models page
- **Label** — human-readable display name (optional)
- **Tier** — `light` / `mid` / `premium`
- **Input $/1M** and **Output $/1M** — from the provider's pricing page

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

### Seed script

To add models as part of setup, extend `SEED` in `server/src/seed/seedModels.js` and run:

```sh
npm run seed:models
```

## Upsert strategy

| Entry state | On seed run |
|---|---|
| Not in DB | Created with `builtIn: true` |
| In DB, `builtIn: true` | Pricing and label updated |
| In DB, `builtIn: false` (user-created) | Skipped — never overwritten |

Built-in models can be **disabled** (toggle in Settings → Models) but not deleted. Custom models can be deleted.
