# JavaScript SDK — arbr-client

Official zero-dependency Node.js client. Node ≥ 18 (uses global `fetch`). CommonJS; works from ESM via `import`.

## Install

```sh
npm install arbr-client
```

## Quick start

```js
const { createClient } = require("arbr-client");

const arbr = createClient({
  baseUrl: "http://localhost:4100",   // or set ARBR_GATEWAY_URL
  application: "my-app",
});

const res = await arbr.chat({ messages: "Summarise this ticket: …", model: "auto", maxTokens: 300 });
console.log(res.text);
console.log(res.model, res.routingDecision);  // "gpt-4o-mini", "ai"
```

## `createClient(options) → client`

| Option | Default | Description |
|---|---|---|
| `baseUrl` | `process.env.ARBR_GATEWAY_URL` | Gateway origin. Required. |
| `apiKey` | `process.env.ARBR_API_KEY` | Gateway key (`ab_…`). Sent as `Authorization: Bearer`. Required when *Require API keys* is on. |
| `application` | — | Default attribution on every call. Strongly recommended. |
| `workflow`, `department`, `userId` | — | More default attribution (overridable per-call). |
| `timeoutMs` | `60000` | Per-attempt timeout via `AbortController`. |
| `retries` | `2` | Retries on network errors, timeouts, 429, 5xx. Exponential backoff + jitter. |
| `fetch` | global `fetch` | Injectable for tests or custom agents. |

## `client.chat(messages, options?) → Promise<ChatResponse>`

```js
const res = await arbr.chat({
  messages: [
    { role: "system", content: "You are a support agent." },
    { role: "user", content: "How do I reset my password?" }
  ],
  model: "auto",
  taskType: "support response",
  maxTokens: 512,
  workflow: "support-chat",
});
```

`messages` accepts: bare string, `{role, content}` objects, or LangChain message objects (anything with `._getType()`).

**ChatResponse fields:**
```js
{
  text: "Click Settings > Security > Reset password.",
  model: "gpt-4o-mini",
  modelRequested: "auto",
  provider: "openai",
  routingDecision: "rule",       // explicit | passthrough | rule | auto | ai | cache | fallback | budget
  classifiedBy: "provided",      // provided | keyword | ai
  cacheHit: false,
  requestId: "a1b2c3...",
  usage: { inputTokens: 22, outputTokens: 9, totalTokens: 31 }
}
```

## `client.stream(messages, options?) → AsyncGenerator<{ text }>`

Buffered shim: makes one `chat()` call and yields the answer in small text chunks. Use the [OpenAI-compat endpoint](/gateway/openai-compat) for real token-by-token SSE.

```js
for await (const chunk of arbr.stream({ messages: "Tell me a story" })) {
  process.stdout.write(chunk.text);
}
// generator return value is the full ChatResponse
```

## `client.status() → Promise<StatusResponse>`

```js
const s = await arbr.status();
// { demoMode, liveProviders, defaultProvider, defaultModel, routingMode, breachedCaps }
```

When the admin key is set server-side, this endpoint accepts the gateway key — so healthchecks work without the admin credential.

## `asLangChainModel(client, meta?) → model`

Returns a duck-typed LangChain-style chat model — **no LangChain dependency**. Supports `.invoke()` / `.ainvoke()` and is callable, so it works in `prompt | model` chains via `RunnableLambda`.

```js
const { asLangChainModel } = require("arbr-client");

const model = asLangChainModel(arbr, { workflow: "answer-drafting", maxTokens: 1024 });
const msg = await model.invoke(messages);
// msg.content, msg.usage_metadata, msg.response_metadata
```

For full Runnable compatibility (callbacks, batch, `with_structured_output`), wrap the client in a real `BaseChatModel` subclass in your app instead.

## Error handling

All failures throw `GatewayError`:

```js
const { GatewayError } = require("arbr-client");
try {
  await arbr.chat({ messages: "…" });
} catch (err) {
  if (err instanceof GatewayError) {
    console.log(err.code, err.status, err.retryable, err.requestId);
  }
}
```

| `code` | Meaning | Retried automatically? |
|---|---|---|
| `invalid_input` | Bad arguments | no |
| `bad_request` | HTTP 400 | no |
| `demo_mode` | No provider keys (HTTP 503) | no |
| `provider_error` | All providers failed (HTTP 502) | yes |
| `http_error` | Other non-2xx | 429/5xx only |
| `invalid_api_key` | Missing/unknown key (HTTP 401) | no |
| `budget_exceeded` | Block cap breached (HTTP 429) | no |
| `rate_limited` | Per-key RPM limit (HTTP 429) | yes |
| `network` | Connection failed | yes |
| `timeout` | Per-attempt timeout | yes |
| `aborted` | `AbortSignal` fired | no |

## Gradual rollout pattern

```js
function makeModel(opts) {
  if (!process.env.ARBR_GATEWAY_URL) return buildDirectProviderModel(opts);
  const arbr = createClient({ application: "my-app" });
  return asLangChainModel(arbr, opts);  // .invoke()/.stream() compatible
}
// Unset ARBR_GATEWAY_URL to revert instantly.
```
