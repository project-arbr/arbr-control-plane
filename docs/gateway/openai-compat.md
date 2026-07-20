# OpenAI-compatible endpoint — POST /v1/chat/completions

Drop-in replacement for the OpenAI chat completions API. Any client that speaks the OpenAI spec — LibreChat, OpenWebUI, LangChain's `ChatOpenAI`, the official `openai` SDK — works without code changes. Just change the base URL.

## Non-streaming

```sh
curl -X POST http://localhost:4100/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer ab_…' \
  -d '{
    "model": "claude-haiku-4-5",
    "messages": [{ "role": "user", "content": "Hello" }],
    "max_tokens": 200
  }'
```

Response is a standard `chat.completion` object:

```json
{
  "id": "chatcmpl-a1b2c3...",
  "object": "chat.completion",
  "model": "claude-haiku-4-5",
  "choices": [{
    "index": 0,
    "message": { "role": "assistant", "content": "Hello! How can I help?" },
    "finish_reason": "stop"
  }],
  "usage": { "prompt_tokens": 10, "completion_tokens": 8, "total_tokens": 18 }
}
```

## Streaming (SSE)

Add `"stream": true` to receive server-sent events token by token:

```sh
curl -N -X POST http://localhost:4100/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{ "role": "user", "content": "Count to 5" }],
    "stream": true
  }'
```

Output (each `data:` line arrives as a token):

```
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","model":"gpt-4o-mini","choices":[{"index":0,"delta":{"content":"1"},"finish_reason":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","model":"gpt-4o-mini","choices":[{"index":0,"delta":{"content":", 2"},"finish_reason":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","model":"gpt-4o-mini","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

See [Streaming](/gateway/streaming) for the full end-to-end guide including LiteLLM → Bedrock chains.

## Using the OpenAI Python SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:4100/v1",
    api_key="ab_…"   # your Arbr gateway key; "none" works when Require API keys is off
)

# Non-streaming
response = client.chat.completions.create(
    model="gemini-2.5-flash",
    messages=[{"role": "user", "content": "Summarise this in one sentence: ..."}]
)
print(response.choices[0].message.content)

# Streaming
stream = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "Tell me a joke"}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="", flush=True)
```

## Using the OpenAI Node.js SDK

```js
import OpenAI from "openai";

const client = new OpenAI({ baseURL: "http://localhost:4100/v1", apiKey: "ab_…" });

// Non-streaming
const response = await client.chat.completions.create({
  model: "claude-haiku-4-5",
  messages: [{ role: "user", content: "Hello" }],
});
console.log(response.choices[0].message.content);

// Streaming
const stream = await client.chat.completions.stream({
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "Tell me a joke" }],
  stream: true,
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}
```

## Routing via the OpenAI-compat endpoint

The endpoint honors the same routing logic as `/v1/chat`. To pin a provider (e.g. LiteLLM), pass it as an extra body field:

```python
client.chat.completions.create(
    model="bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0",
    messages=[...],
    extra_body={"provider": "openai"},   # route through the LiteLLM-backed OpenAI provider
)
```

## Request field mapping

| OpenAI field | Arbr field |
|---|---|
| `model` | `model` |
| `messages` | `messages` |
| `max_tokens` | `maxTokens` |
| `temperature` | `temperature` |
| `stream` | `stream` |
| `extra_body.provider` | `provider` (pass-through routing) |
| — | `application` → mapped from gateway API key |

`workflow`, `department`, and `userId` aren't OpenAI fields, but Arbr still captures them for attribution: `workflow` from an `x-arbr-workflow` header, `department` from an `x-arbr-department` header or the API key's own `department`, and `userId` from the standard OpenAI `user` field, an `x-arbr-user-id` header, or the API key's `userId` — checked in that order.

## Chat UI integration (LibreChat, OpenWebUI, etc.)

Set the base URL to `http://your-arbr-host:4100` and your gateway key as the API key. The UI works immediately — every message is now routed, logged, and governed by Arbr.

For step-by-step guides, see [Connect LibreChat](/integrations/librechat) and, for terminal-based coding agents, [Connect OpenCode](/integrations/opencode).
