# Quickstart

Get Arbr running and make your first routed AI call in under five minutes.

## Requirements

- **Docker** (Option A — recommended) or **Node.js ≥ 18** + a running MongoDB (Option B)
- No API keys required to explore — the app ships with **demo mode** that seeds realistic data so every dashboard, the recommendation engine, and routing controls work immediately

## Install

::: code-group

```sh [Docker (recommended)]
git clone https://github.com/project-arbr/arbr-control-plane
cd arbr-control-plane
cp .env.example .env
docker compose up
```

```sh [Local — Node + MongoDB]
git clone https://github.com/project-arbr/arbr-control-plane
cd arbr-control-plane
npm run setup   # install deps + seed built-in models + demo request records
npm run dev     # server on :4100, dashboard on :5173
```

:::

Open **http://localhost:4100** — the dashboard loads with seeded demo data. Go to **Recommendations → Recompute** to see the engine in action.

## Add a provider key

The demo dashboard works without any keys. To make real AI calls:

1. Open **Settings → Connections**
2. Paste a key for any provider (OpenAI, Anthropic, Gemini, DeepSeek, …)
3. The provider goes live immediately — no restart

Or set the environment variable before starting:

```env
# .env
OPENAI_API_KEY=sk-...
```

Environment variables take precedence over dashboard-stored keys. See [Providers](/providers/overview) for all supported providers.

## Make your first call

Once a provider is live, hit the gateway:

::: code-group

```sh [curl]
curl -X POST http://localhost:4100/v1/chat \
  -H 'Content-Type: application/json' \
  -d '{
    "application": "my-app",
    "messages": "What is the capital of France?",
    "model": "auto"
  }'
```

```js [JavaScript SDK]
// npm install arbr-client
const { createClient } = require("arbr-client");

const arbr = createClient({ baseUrl: "http://localhost:4100", application: "my-app" });
const res = await arbr.chat({ messages: "What is the capital of France?", model: "auto" });
console.log(res.text, res.model, res.routingDecision);
```

```python [Python SDK]
# pip install arbr-client
from arbr_client import create_client

arbr = create_client("http://localhost:4100", application="my-app")
res = arbr.chat("What is the capital of France?", model="auto")
print(res.text, res.model, res.routing_decision)
```

:::

Response:

```json
{
  "text": "Paris.",
  "model": "gpt-4o-mini",
  "modelRequested": "auto",
  "routingDecision": "auto",
  "classifiedBy": "keyword",
  "usage": { "inputTokens": 14, "outputTokens": 2, "totalTokens": 16 },
  "requestId": "a1b2c3..."
}
```

The call is now visible in the dashboard under **Overview** and **Requests**.

## What's next

- [How the gateway works](/gateway/overview) — request flow, two endpoints, routing precedence
- [Connect providers](/providers/overview) — all 8 supported providers
- [Routing](/routing) — rules, guardrail, AI policy, explicit pins
- [Deploy to production](/deployment) — Docker Compose, nginx, production checklist
