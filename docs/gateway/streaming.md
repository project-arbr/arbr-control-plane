# Streaming

Arbr supports real, token-by-token SSE streaming through the OpenAI-compatible endpoint — but only for the **OpenAI-compat provider set**: `openai`, `deepseek`, `moonshot`, `xai`, `groq`, `litellm` (and any custom OpenAI-compatible provider you add). For these, Arbr raw-proxies the upstream response over `fetch`, byte-for-byte, with no LangChain in the path and no intermediate buffering.

> **Native providers don't stream token-by-token.** For `anthropic`, `gemini`, and `bedrock-nova` (without tool calls), Arbr calls LangChain's `invoke()` — not `.stream()` — waits for the *entire* response, and then emits it as three SSE frames back to back: a role-delta, one chunk containing the full response text, and a finish chunk. The response is still valid SSE and still arrives on `stream: true`, but nothing is incremental: the client sees no chunks at all until the whole answer is ready, then gets it all at once. This is deliberate, not a bug — LangChain's `.stream()` filters out thinking tokens per-chunk for thinking models (Gemini 2.5 Pro/Flash, Claude 3.x), which truncates the visible answer; `invoke()` assembles the full response correctly. See `server/src/gateway/openaiCompat.js` for the buffered-emit path. Every Claude/Gemini/Bedrock example below is therefore "streaming" in protocol only, not in delivery.

## How it works

```
OpenAI-compat providers (openai, deepseek, moonshot, xai, groq, litellm):
Client ──stream:true──▶ Arbr /v1/chat/completions ──▶ raw fetch proxy ──▶ Provider
                               │                                              │
                               ◀─── SSE chunk (data: {...}) ◀─── token ──────┘

Native providers (anthropic, gemini, bedrock-nova w/o tools):
Client ──stream:true──▶ Arbr /v1/chat/completions ──▶ LangChain model.invoke() ──▶ Provider
                               │                                                        │
                               ◀── 3 SSE frames (role, full text, finish) ◀── full response ─┘
```

When `stream: true` is set for an **OpenAI-compat** model:

1. Arbr sends the `200 OK` + `Content-Type: text/event-stream` headers **immediately** (before any tokens arrive), so clients and proxies know they're getting an SSE stream
2. Arbr opens a raw streaming `fetch` to the upstream (or LiteLLM) and relays the bytes unchanged
3. Each token chunk is forwarded as a `data: {...}` SSE event
4. The stream ends with `data: [DONE]`

For a **native** model, the same headers go out immediately, but no data follows until the full `invoke()` response comes back — then Arbr writes all three SSE frames and ends the stream. There is no step 2/3 equivalent: no incremental chunks exist to forward.

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

Each token arrives in real-time. Because `provider: "openai"` routes through the OpenAI-compat raw proxy (LiteLLM speaks the OpenAI protocol), there's no LangChain in this path at all — Arbr relays the raw upstream SSE bytes without buffering, so the chain is Application → Arbr → LiteLLM → Bedrock → back with no delays between hops. (Calling a Bedrock model directly through the native `bedrock-nova` provider, instead of via LiteLLM, hits the buffered path described above.)

## Streaming vs buffered `stream()`

The arbr-client SDKs have a `stream()` / `astream()` method that works differently from the SSE endpoint:

| | OpenAI-compat SSE | arbr-client `stream()` |
|---|---|---|
| Endpoint | `POST /v1/chat/completions` | `POST /v1/chat` |
| Token delivery | Real-time, token by token — **only for OpenAI-compat providers** (see the callout above; native providers buffer the full response and emit it as one chunk even here) | Buffered — full call, then yields chunks |
| Routing metadata | Not in stream chunks | Available on generator return value |
| Use when | Chat UIs, latency-sensitive streaming (OpenAI-compat models) | Buffered streaming with routing metadata |

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
