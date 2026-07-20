# LiteLLM Proxy

Connect a self-hosted LiteLLM proxy as a provider. Arbr talks to it over LiteLLM's own
OpenAI-compatible API — the same interface any OpenAI-compatible client already uses.

Arbr connects to your LiteLLM proxy as an upstream — it doesn't replace LiteLLM's provider
routing. Keep using LiteLLM for provider breadth; Arbr sits above it for cost tracking,
recommendations, evaluation gates, and rollout.

## Connect

1. Open **Models**, and find **LiteLLM Proxy** in the sidebar — it's always listed, even
   before you've connected anything.
2. Click **Connect** and enter:
   - **Base URL** — your LiteLLM proxy's address, e.g. `http://localhost:4000`
   - **API Key** — the proxy's master key
3. **Test connection** — sends a real chat request through the proxy to confirm it's reachable.
4. **Discover models** — lists everything your LiteLLM instance currently serves.
5. **Import** the ones you want — each is added with its exact model ID and, where LiteLLM's
   catalog has it, real pricing. Explicit import (rather than passing through unknown model
   strings) is what gives Arbr accurate per-model cost data for recommendations and budgets.

Streaming works the same way as any other provider — requests flow Application → Arbr →
LiteLLM → the underlying provider, response bytes streamed back unchanged.

## Env-only setup via `LITELLM_BASE_URL`

There's also a builtin, env-configured path that registers a genuine `litellm` provider in
Arbr's provider registry, distinct from the dashboard flow above (which creates a
`CustomProvider` record) and from the unrelated `OPENAI_BASE_URL` redirect trick documented in
[OpenAI](/providers/openai#using-as-a-litellm-proxy) (which reuses the `openai` provider
instead of registering a new one):

```env [.env]
LITELLM_BASE_URL=http://localhost:4000
LITELLM_API_KEY=your-litellm-master-key
LITELLM_DEFAULT_MODEL=gpt-4o-mini   # optional
```

Set these before starting the server — `litellm` is only added to the provider registry at
boot, and a restart is required to pick up changes. Once set, route requests with
`"provider": "litellm"`. As with the `OPENAI_BASE_URL` trick, models aren't pre-registered
with pricing this way — register them via `POST /api/models` with `{ "provider": "litellm" }`
if you want cost tracking, or use the dashboard **Connect** flow above for automatic pricing
import instead.
