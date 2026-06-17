# Streaming

Arbr supports real token-by-token SSE streaming through the OpenAI-compatible endpoint. The stream flows all the way from the provider through Arbr to your client with no intermediate buffering.

## How it works

```
Client ──stream:true──▶ Arbr /v1/chat/completions ──▶ LangChain model.stream() ──▶ Provider
                               │                                                       │
                               ◀─── SSE chunk (data: {...}) ◀─── token ───────────────┘
```

When `stream: true` is set:

1. Arbr sends the `200 OK` + `Content-Type: text/event-stream` headers **immediately** (before any tokens arrive), so clients and proxies know they're getting an SSE stream
2. LangChain's `.stream()` makes a real streaming HTTP request to the provider (or LiteLLM)
3. Each token chunk is forwarded as a `data: {...}` SSE event
4. The stream ends with `data: [DONE]`

## Basic streaming call

::: code-group

```sh [curl]
curl -N -X POST http://localhost:4100/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{ "role": "user", "content": "Write a haiku about databases" }],
    "stream": true
  }'
```

```python [Python SDK]
from openai import OpenAI

client = OpenAI(base_url="http://localhost:4100/v1", api_key="ab_…")
stream = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "Write a haiku about databases"}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="", flush=True)
```

```js [Node.js SDK]
import OpenAI from "openai";
const client = new OpenAI({ baseURL: "http://localhost:4100/v1", apiKey: "ab_…" });

const stream = await client.chat.completions.stream({
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "Write a haiku about databases" }],
  stream: true,
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}
```

:::

## Streaming through LiteLLM → Bedrock

To stream through the full chain — **Application → Arbr → LiteLLM → Bedrock** — point the OpenAI provider at your LiteLLM instance and use pass-through routing:

**1. Configure LiteLLM as the OpenAI base URL**

```env
# .env
OPENAI_API_KEY=your-litellm-master-key
OPENAI_BASE_URL=http://localhost:8000   # LiteLLM URL
```

**2. Stream with a Bedrock model ID**

::: code-group

```sh [curl]
curl -N -X POST http://localhost:4100/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "provider": "openai",
    "model": "bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0",
    "messages": [{ "role": "user", "content": "Tell me a joke" }],
    "stream": true
  }'
```

```python [Python SDK]
from openai import OpenAI

client = OpenAI(base_url="http://localhost:4100/v1", api_key="ab_…")
stream = client.chat.completions.create(
    model="bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0",
    messages=[{"role": "user", "content": "Tell me a joke"}],
    extra_body={"provider": "openai"},
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="", flush=True)
```

:::

Each token arrives in real-time. Arbr pipes LangChain chunks to the SSE response without buffering — the chain is Application → Arbr → LiteLLM → Bedrock → back with no delays between hops.

## Streaming vs buffered `stream()`

The arbr-client SDKs have a `stream()` / `astream()` method that works differently from the SSE endpoint:

| | OpenAI-compat SSE | arbr-client `stream()` |
|---|---|---|
| Endpoint | `POST /v1/chat/completions` | `POST /v1/chat` |
| Token delivery | Real-time, token by token | Buffered — full call, then yields chunks |
| Routing metadata | Not in stream chunks | Available on generator return value |
| Use when | Chat UIs, latency-sensitive streaming | Buffered streaming with routing metadata |

## Nginx configuration for SSE

If running Arbr behind nginx, add these directives to the location block to prevent response buffering:

```nginx
location /v1/chat/completions {
    proxy_pass http://127.0.0.1:4100;
    proxy_set_header Connection '';
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 300s;
    chunked_transfer_encoding on;
}
```

The `X-Accel-Buffering: no` header is already sent by Arbr, which also tells nginx to disable buffering for this response.
