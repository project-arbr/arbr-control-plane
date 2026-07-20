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

## Already using `LITELLM_BASE_URL`?

There's an older, still-supported path: set `OPENAI_BASE_URL` to your LiteLLM instance and
requests with `provider: "openai"` get forwarded there, accepting any model string LiteLLM
understands — even ones not in Arbr's registry. That flexibility comes at a cost: models
never explicitly imported have no pricing data, so cost tracking and recommendations can't see
them accurately. See [OpenAI](/providers/openai#using-as-a-litellm-proxy) for that setup. The
dashboard flow above is recommended whenever cost visibility matters.
