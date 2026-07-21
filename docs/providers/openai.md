# OpenAI

Provider ID: `openai`

Connects to OpenAI's chat API — or any OpenAI-compatible endpoint (LiteLLM, vLLM, Ollama, etc.) via `OPENAI_BASE_URL`.

Connecting a LiteLLM proxy specifically? See [LiteLLM Proxy](/providers/litellm) for the
dashboard-based setup — recommended whenever cost tracking matters, since it imports exact
model IDs and pricing rather than passing through unregistered model strings.

## Connect

::: code-group

```env [.env]
OPENAI_API_KEY=sk-...
# Optional: redirect to a LiteLLM proxy or other OpenAI-compatible endpoint
# OPENAI_BASE_URL=http://localhost:8000
```

```
Dashboard: Models → OpenAI → API Key
```

:::

## Built-in models

| Model ID | Label | Tier | Input $/1M | Output $/1M |
|---|---|---|---|---|
| `gpt-4o` | GPT-4o | premium | $2.50 | $10.00 |
| `gpt-4o-mini` | GPT-4o Mini | light | $0.15 | $0.60 |

## Example

```sh
curl -X POST http://localhost:4100/v1/chat \
  -H 'Content-Type: application/json' \
  -d '{
    "provider": "openai",
    "model": "gpt-4o-mini",
    "messages": [{ "role": "user", "content": "Summarise this ticket in two sentences: my order never arrived." }]
  }'
```

## Using as a LiteLLM proxy

Set `OPENAI_BASE_URL` to your LiteLLM instance URL. All requests with `provider: "openai"` are forwarded there, and any model string LiteLLM understands is accepted — even models not in Arbr's registry (pass-through routing):

```env
OPENAI_API_KEY=your-litellm-master-key
OPENAI_BASE_URL=http://localhost:8000
```

Then route to any Bedrock model:

```sh
curl -X POST http://localhost:4100/v1/chat \
  -H 'Content-Type: application/json' \
  -d '{
    "provider": "openai",
    "model": "bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0",
    "messages": [{ "role": "user", "content": "Hello" }]
  }'
```

See [Streaming](/gateway/streaming) for the full Application → Arbr → LiteLLM → Bedrock streaming guide.
