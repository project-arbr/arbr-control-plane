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

## Team attribution — identifying developers

When a team shares one gateway key, pass `userId` to attribute each developer's requests
separately. Set it at the client level so every call is attributed automatically:

```js
const arbr = createClient({
  baseUrl: process.env.ARBR_GATEWAY_URL,
  apiKey: process.env.ARBR_API_KEY,
  application: "opencode",
  userId: process.env.ARBR_USER_ID,     // e.g. "alice@company.com"
  department: "engineering",            // optional team grouping
});
```

Or override per-call when a single client instance serves multiple users:

```js
await arbr.chat({
  messages: "…",
  userId: session.user.email,
});
```

Each developer's spend and requests appear separately in **Overview → Applications → opencode**
with no additional key management needed.

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

## `client.models() → Promise<ModelsResponse>`

Returns all models available on this Arbr instance — only models whose provider is currently connected are included. Each entry carries a `toolCallSupported` flag so you can decide whether to enable the Search / function-calling UI for that model.

```js
const { data } = await arbr.models();

// data is an array of ArbrModel:
// {
//   id: "gpt-4o",
//   provider: "openai",
//   label: "GPT-4o",
//   tier: "premium",        // "light" | "mid" | "premium"
//   inputPer1M: 2.5,        // USD per 1M input tokens
//   outputPer1M: 10.0,
//   toolCallSupported: true // false for Gemini, DeepSeek R1, GLM, etc.
// }

// Filter to only tool-capable models (for a Search toggle or function-calling UI):
const toolModels = data.filter((m) => m.toolCallSupported);

// Check before sending tools:
const model = data.find((m) => m.id === "us.deepseek.r1-v1:0");
if (model && !model.toolCallSupported) {
  console.warn("Search is not supported for this model — disabling.");
}
```

**`toolCallSupported` rules:**

`true` for `openai`, `deepseek`, `groq`, `xai`, `moonshot`, `litellm` — these proxy tools
natively. For Bedrock (`provider: "bedrock-nova"`), it's a pattern-matched allowlist against the
model id, not a blanket Nova-only rule:

| Value | Bedrock models |
|-------|--------------------|
| `true` | Amazon Nova (`nova-lite`, `nova-micro`, `nova-pro`, `nova-premier`), Claude 3.x (Haiku, Sonnet, Opus, 3.5, 3.7), Llama 3.x, Command R / R+, Mistral Large / Small, AI21 Jamba, Writer Palmyra X5, Kimi K2.5 |
| `false` | Everything else on Bedrock not matched above (e.g. Mistral 7B, Mixtral 8x7B, DeepSeek R1 (`us.deepseek.r1-v1:0`)) |

`false` outright for `gemini` and direct `anthropic` (not proxied through Bedrock's Converse API).
See `BEDROCK_TOOL_PATTERNS` in `server/src/gateway/capabilities.js` for the exact list.

## `client.taskTypes() → Promise<TaskTypesResponse>`

Returns all supported task types with their routing tier and a plain-English description. Use the `id` values as the `taskType` field in `chat()` calls to activate smart routing.

```js
const { data } = await arbr.taskTypes();

// data is an array of { id, tier, label, description }
// e.g. { id: "coding", tier: "mid", label: "Code generation", description: "Write a function…" }

// Pick a task type for your use case:
const taskType = "code-review"; // tier: mid
const res = await arbr.chat({
  messages: [{ role: "user", content: "Review this PR diff: …" }],
  taskType,
});
```

**Tier routing behaviour:**
| Tier | Routed to | When to use |
|------|-----------|-------------|
| `light` | Cheapest fast model | FAQ, translation, classification, autocomplete |
| `mid` | Balanced model | Code generation, support replies, extraction |
| `premium` | Most capable model | Reasoning, architecture design, security audit |

## `client.embeddings(options) → Promise<EmbeddingsResponse>`

Generate vector embeddings — `POST /v1/embeddings`. OpenAI-compatible wire format, same observability as chat.

```js
// Single input
const res = await arbr.embeddings({
  model: "gemini-embedding-001",
  input: "Summarise the customer's pain points",
  dimensions: 768,   // must match your index size
});
const vector = res.data[0].embedding;  // float[] of length 768

// Batch
const res = await arbr.embeddings({
  model: "gemini-embedding-001",
  input: ["sentence one", "sentence two", "sentence three"],
  dimensions: 768,
});
const vectors = res.data.map((d) => d.embedding);  // float[][] — one per input
```

**Options:**

| Option | Required | Description |
|---|---|---|
| `model` | yes | Embedding model ID. Gemini: `"gemini-embedding-001"`. OpenAI: `"text-embedding-3-small"`, `"text-embedding-3-large"`, etc. |
| `input` | yes | String or array of strings to embed. |
| `dimensions` | no | Truncate output to this many dimensions. For Gemini this becomes `outputDimensionality`. **Must match your vector index size** — changing it after index creation breaks search. |
| `timeoutMs`, `retries`, `signal` | no | Same per-call overrides as `chat()`. |

**Response:**
```js
{
  object: "list",
  data: [{ object: "embedding", index: 0, embedding: [0.012, -0.045, …] }],
  model: "gemini-embedding-001",
  usage: { prompt_tokens: 8, total_tokens: 8 }
}
```

Works as a drop-in for any OpenAI SDK targeting the gateway:
```js
import OpenAI from "openai";
const openai = new OpenAI({ baseURL: "http://localhost:4100/v1", apiKey: "ab_…" });
const res = await openai.embeddings.create({ model: "gemini-embedding-001", input: texts, dimensions: 768 });
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
