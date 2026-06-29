# arbr-client

Official JavaScript client for the **Arbr AI control plane** — one function to route, observe,
and govern every LLM call your app makes.

Your app calls the gateway instead of provider SDKs. The gateway holds the provider keys,
honors the model you pin (or picks one when you say `"auto"`), applies human-approved routing
rules and cost policies, and logs every call with full cost attribution — visible in the dashboard.

- **Zero dependencies.** Node ≥ 18 (global `fetch`). CommonJS, works from ESM via `import`.
- **One function for the 90% case** — `chat()`.
- **Robust by default** — per-attempt timeouts, retries with exponential backoff + jitter on
  network errors / 429 / 5xx, typed errors, `AbortSignal` support.
- **TypeScript-ready** — full type definitions included.

## Install

```sh
npm install arbr-client
# (pre-release: npm install /path/to/arbr-client-0.1.0.tgz)
```

## 60-second quickstart

```js
const { createClient } = require("arbr-client");

const arbr = createClient({
  baseUrl: "http://localhost:4100",   // or set ARBR_GATEWAY_URL
  application: "my-app",              // attribution — shows up in the dashboard
});

const res = await arbr.chat({
  messages: "Summarise this support ticket in two sentences: …",
  model: "auto",                      // let the gateway's router decide
  maxTokens: 300,
});

console.log(res.text);
console.log(res.model, res.routingDecision); // e.g. "gpt-4o-mini", "ai"
```

That's a complete integration. No provider keys in your app, and every call is logged,
costed, and governable from the dashboard.

## How model choice works

| You send | What happens |
|---|---|
| `model: "gpt-4o"` (provider connected) | Honored **as-is** — all routing policies skipped. `routingDecision: "explicit"` |
| `model: "auto"` or omitted | The gateway decides: cache → operator rules → automated routing (cost guardrail or AI policy) → default model |
| `model` whose provider isn't connected | Falls back to the router (same as `"auto"`) |

`res.modelRequested` always shows what you asked for, `res.model` what actually served it, and
`res.routingDecision` why (`explicit` / `rule` / `auto` / `ai` / `cache` / `fallback` / `passthrough`).

If you don't send a `taskType`, the gateway infers one (keyword heuristic, or an AI classifier
when AI routing is enabled) — `res.classifiedBy` tells you which (`provided` / `keyword` / `ai`).

When AI routing is on, the gateway also classifies **difficulty** (easy / normal / hard) and may
adjust the model pick within the tier — easy requests can route to a cheaper model, hard ones to
a stronger one. The difficulty score and routing explanation are logged per-request and visible in
the dashboard Requests drilldown.

## API

### `createClient(options) → client`

| Option | Default | Notes |
|---|---|---|
| `baseUrl` | `process.env.ARBR_GATEWAY_URL` | Gateway origin. Required (here or via env). |
| `apiKey` | `process.env.ARBR_API_KEY` | Gateway API key (`ab_…`, dashboard → Settings → API keys). Sent as `Authorization: Bearer`; binds attribution server-side. Required once the gateway has *Require API keys* on. |
| `application` | — | Default attribution merged into every call. Strongly recommended. |
| `workflow`, `department`, `userId` | — | More default attribution. |
| `timeoutMs` | `60000` | Per attempt, via `AbortController`. |
| `retries` | `2` | Network errors / timeouts / 429 / 5xx only. Exponential backoff + jitter. |
| `fetch` | global `fetch` | Injectable for tests or custom agents. |

### `client.chat(request) → Promise<ChatResponse>`

Request fields: `messages` (required), `model`, `provider`, `taskType`, `temperature`,
`maxTokens`, per-call `application`/`workflow`/`department`/`userId` (override the defaults),
`timeoutMs`, `retries`, `signal`.

`messages` accepts any of:

```js
"a bare string"                                       // → one user message
[{ role: "system", content: "…" }, { role: "user", content: "…" }]
[someLangChainMessage]                                 // anything with ._getType()
```

Response: `{ requestId, model, modelRequested, provider, routingDecision, classifiedBy,
cacheHit, text, usage: { inputTokens, outputTokens, totalTokens, cachedReadTokens, cacheWriteTokens } }`.

`usage.cachedReadTokens` and `usage.cacheWriteTokens` are non-zero when the provider's prompt
cache was active (Anthropic, OpenAI). The gateway prices these at provider cache rates automatically.

### Streaming

The gateway supports two streaming modes:

**Real SSE (token-by-token)** — use the OpenAI-compatible endpoint at `POST /v1/chat/completions`
with `stream: true`. Works with the OpenAI Node.js SDK, Python SDK, any chat UI, or a raw fetch:

```js
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: "ab_…", baseURL: "http://localhost:4100" });
const stream = await openai.chat.completions.stream({
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "Tell me a joke" }],
  stream: true,
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}
```

**`client.stream(request) → AsyncGenerator<{ text }>`** — the `arbr-client` `stream()` method
calls `POST /v1/chat`, collects the full response, and yields it in small text chunks. Full routing
metadata is available on the generator's return value. Useful when you want the attribution
response (`res.model`, `res.routingDecision`, etc.) alongside a streaming-style emit:

```js
for await (const chunk of arbr.stream({ messages: "…" })) {
  process.stdout.write(chunk.text);
}
```

Use the OpenAI-compat endpoint when you need real token-by-token delivery or are integrating with
chat UIs. Use `stream()` when you want the routing metadata the OpenAI endpoint doesn't expose.

### `client.status() → Promise<StatusResponse>`

Healthcheck against `GET /api/status`:
`{ demoMode, liveProviders, defaultProvider, defaultModel, routingMode, breachedCaps }`.
When the gateway has admin auth enabled (`ARBR_ADMIN_KEY` set server-side), this endpoint
requires a credential — your gateway `apiKey` is accepted, so set it and `status()` keeps working.

### `client.models() → Promise<ModelsResponse>`

List every model available on this Arbr instance — `GET /v1/models`.
Uses the same gateway API key as chat calls (no admin key needed).

```js
const { data: models } = await arbr.models();

// Find all light-tier models, sorted by input cost
const cheap = models
  .filter(m => m.tier === "light")
  .sort((a, b) => a.inputPer1M - b.inputPer1M);

console.log(cheap[0].id, cheap[0].provider); // e.g. "us.amazon.nova-micro-v1:0", "bedrock-nova"
```

Response shape is OpenAI-compatible (`{ object: "list", data: [...] }`) with Arbr extensions on each model:

| Field | Type | Description |
|---|---|---|
| `id` | string | Model ID — pass as `model:` in chat calls |
| `provider` | string | Underlying provider (`"openai"`, `"bedrock-nova"`, `"anthropic"`, …) |
| `label` | string | Human-readable name |
| `tier` | `"light"` \| `"mid"` \| `"premium"` | Cost tier |
| `inputPer1M` | number | USD per 1M input tokens |
| `outputPer1M` | number | USD per 1M output tokens |

Because the response is OpenAI-compatible, it also works directly via the OpenAI Node.js SDK:

```js
import OpenAI from "openai";
const openai = new OpenAI({ apiKey: "ab_…", baseURL: "https://your-control-plane.example.com/v1" });
const list = await openai.models.list();
list.data.forEach(m => console.log(m.id));
```

### `client.providers() → Promise<ProvidersResponse>`

List which providers are live on this instance — `GET /v1/providers`.
Returns `{ object: "list", data: [{ id, models: string[] }] }`. No credentials exposed.

```js
const { data: providers } = await arbr.providers();

for (const p of providers) {
  console.log(p.id, "→", p.models.length, "models");
}
// openai       → 2 models
// bedrock-nova → 11 models
// anthropic    → 3 models
```

### `asLangChainModel(client, meta?) → { invoke, stream }`

For apps that centralise LLM calls behind a factory (the recommended chokepoint pattern):
returns a duck-typed LangChain-style chat model — **no LangChain dependency** — whose
`.invoke(messages)` resolves to an AIMessage-shaped object (`content`, `usage_metadata`,
`response_metadata`) and `.stream(messages)` yields `{ content }` chunks.

```js
const model = asLangChainModel(arbr, { workflow: "answer-drafting", maxTokens: 1024 });
const msg = await model.invoke(messages);   // msg.content, msg.usage_metadata
```

## Error handling

All failures throw `GatewayError` with `status`, `code`, `retryable`, and (when available)
`requestId`:

| `code` | Meaning | Retried automatically? |
|---|---|---|
| `invalid_input` | Bad arguments (caught before any network call) | no |
| `bad_request` | Gateway rejected the request (HTTP 400) | no |
| `demo_mode` | Gateway has no provider keys configured (HTTP 503) | no |
| `provider_error` | All providers failed for this call (HTTP 502) | yes (5xx) |
| `http_error` | Other non-2xx | 429/5xx only |
| `invalid_api_key` | Missing/unknown/revoked gateway API key (HTTP 401) | no |
| `budget_exceeded` | A budget cap with action *Block* is breached for your scope (HTTP 429) | no — retrying won't help until the window rolls past |
| `rate_limited` | Your API key is over its requests/minute limit (HTTP 429) | yes |
| `network` | Connection failed | yes |
| `timeout` | Per-attempt timeout elapsed | yes |
| `aborted` | Your `AbortSignal` fired | no |

```js
const { GatewayError } = require("arbr-client");
try {
  await arbr.chat({ messages: "…" });
} catch (err) {
  if (err instanceof GatewayError && err.code === "demo_mode") {
    // gateway is up but has no provider keys — fall back or surface to ops
  } else {
    throw err;
  }
}
```

## Integration recipes

**Express handler:**

```js
const arbr = createClient({ baseUrl: process.env.ARBR_GATEWAY_URL, application: "support-api" });

app.post("/answer", async (req, res) => {
  const out = await arbr.chat({
    messages: req.body.messages,
    workflow: "answer-drafting",
    model: "auto",
    maxTokens: 1024,
  });
  res.json({ answer: out.text, model: out.model });
});
```

**Gradual rollout behind an env flag** (no business-code changes — swap at the factory):

```js
function makeModel(opts) {
  if (!process.env.ARBR_GATEWAY_URL) return buildDirectProviderModel(opts); // unchanged path
  const arbr = createClient({ application: "my-app" });
  return asLangChainModel(arbr, opts);  // .invoke()/.stream() compatible
}
```

Unset `ARBR_GATEWAY_URL` to revert instantly.

## License

MIT
