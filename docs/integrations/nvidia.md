# Connect NVIDIA (or any OpenAI-compatible provider)

Arbr can route to any provider that exposes an OpenAI-compatible API, without a code change. NVIDIA's
[build.nvidia.com](https://build.nvidia.com) is a good example: a single free `nvapi-` key unlocks 100+
models (DeepSeek, Qwen, Kimi, GLM, MiniMax, …) at `https://integrate.api.nvidia.com/v1`.

## 1. Connect the provider

In the dashboard, go to **Models**. NVIDIA appears in the provider catalog (its models are already in the
registry from the model sync). Open it and **Connect**: the base URL is prefilled
(`https://integrate.api.nvidia.com/v1`); paste your `nvapi-` key and save. Use **Test connection** to
verify.

For a provider not in the catalog, use **Add custom provider** and supply:
- **Provider ID** — a slug, e.g. `my-provider`
- **Base URL** — the OpenAI-compatible root, ending in `/v1`
- **API key**

The key is stored encrypted; the provider goes live immediately.

## 2. Import its models

On the connected provider, click **Discover models**. Arbr calls the provider's `GET /v1/models` and lists
what's available. Select the ones you want and **Import** — they're registered as routable models.

- Models Arbr already knows (from the LiteLLM catalog sync) keep their pricing and capability metadata.
- Unknown models are imported with `$0` pricing (cost logs as $0 until you set a price on the model). You
  can edit pricing per model afterward.

For NVIDIA specifically, its catalog models are already synced, so many will show as **registered** and
route as soon as you connect the key.

## 3. Route to it

Reference an imported model by id from any client:

```sh
curl -X POST https://your-arbr-host/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer ab_…' \
  -d '{ "model": "deepseek-ai/deepseek-v4-flash", "messages": [{ "role": "user", "content": "Hello" }] }'
```

Arbr proxies the request to the provider's endpoint with your stored key, preserving tools, streaming, and
vision. It shows up in **Overview** / **Requests** like any other model, and can be used in rules and the
AI policy.

## Notes
- **Rate limits** are the provider's, not Arbr's (NVIDIA's free tier is ~40 req/min).
- **Pricing** for a newly-imported model defaults to $0 until you set it; spend reporting is only accurate
  once pricing is entered (or inherited from the catalog).
- Everything stays OpenAI-compatible, so there's no vendor lock-in — swap the model id and go.

## Related
- [Providers overview](/providers/overview)
- [OpenAI-compatible endpoint](/gateway/openai-compat)
- [Model registry](/models)
