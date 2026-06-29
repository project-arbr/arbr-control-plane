# arbr-client (Python)

Official Python client for the **Arbr AI control plane** — one function to route, observe,
and govern every LLM call your app makes.

Your app calls the gateway instead of provider SDKs. The gateway holds the provider keys,
honors the model you pin (or picks one when you say `"auto"`), applies human-approved routing
rules and cost policies, and logs every call with full cost attribution — visible in the dashboard.

- **Zero dependencies** — Python ≥ 3.11, stdlib only. Sync *and* async (`achat`/`astream`).
- **One function for the 90% case** — `chat()`.
- **Robust by default** — per-attempt timeouts, retries with exponential backoff + jitter on
  network errors / 429 / 5xx, typed errors.
- **Optional LangChain integration** — a real `BaseChatModel` via `arbr-client[langchain]`.

## Install

```sh
pip install arbr-client                # core (zero deps)
pip install "arbr-client[langchain]"   # + the LangChain BaseChatModel adapter
# (pre-release: pip install /path/to/arbr_client-0.1.0-py3-none-any.whl)
```

## 60-second quickstart

```python
from arbr_client import create_client

arbr = create_client(
    "http://localhost:4100",      # or set ARBR_GATEWAY_URL
    application="my-app",         # attribution — shows up in the dashboard
)

res = arbr.chat("Summarise this support ticket: ...", model="auto", max_tokens=300)
print(res.text)
print(res.model, res.routing_decision)   # e.g. "gpt-4o-mini", "ai"
```

Async (FastAPI, LangGraph, etc.):

```python
res = await arbr.achat("Summarise this ticket: ...", model="auto")
```

That's a complete integration. No provider keys in your app, and every call is logged,
costed, and governable from the dashboard.

## How model choice works

| You send | What happens |
|---|---|
| `model="gpt-4o"` (provider connected) | Honored **as-is** — all routing policies skipped. `routing_decision == "explicit"` |
| `model="auto"` or omitted | The gateway decides: cache → operator rules → automated routing (cost guardrail or AI policy) → default model |
| a model whose provider isn't connected | Falls back to the router (same as `"auto"`) |

`res.model_requested` shows what you asked for, `res.model` what served it, `res.routing_decision`
why (`explicit / rule / auto / ai / cache / fallback / passthrough`), and `res.classified_by` how
the task type was determined (`provided / keyword / ai`).

When AI routing is on, the gateway also classifies **difficulty** (easy / normal / hard) and may
adjust the model pick within the tier. The difficulty score and routing explanation are logged
per-request and visible in the dashboard Requests drilldown.

## API

### `create_client(base_url=None, *, application=None, workflow=None, department=None, user_id=None, api_key=None, timeout_s=60, retries=2) → Client`

`base_url` falls back to `$ARBR_GATEWAY_URL`; `api_key` to `$ARBR_API_KEY`. A gateway API key
(`ab_…`, dashboard → Settings → API keys) is sent as `Authorization: Bearer` and binds attribution
server-side — required once the gateway has *Require API keys* on. The metadata kwargs are defaults
merged into every call (per-call kwargs override them).

### `Client.chat(messages, *, model=None, provider=None, task_type=None, temperature=None, max_tokens=None, ...) → ChatResponse`

`messages` accepts a bare string, `{"role", "content"}` dicts, or LangChain message objects.
`ChatResponse` is a frozen dataclass: `text`, `usage` (`input_tokens/output_tokens/total_tokens/cached_read_tokens/cache_write_tokens`),
`model`, `model_requested`, `provider`, `routing_decision`, `classified_by`, `cache_hit`,
`request_id`, plus `.raw` (the unmodified gateway payload).

`usage.cached_read_tokens` and `usage.cache_write_tokens` are non-zero when the provider's prompt
cache was active (Anthropic, OpenAI). The gateway prices these at provider cache rates automatically.

### `Client.achat(...)` / `Client.astream(...)` / `Client.astatus()`

Async counterparts (the blocking call runs in a worker thread via `asyncio.to_thread`).

### Streaming

The gateway supports two streaming modes:

**Real SSE (token-by-token)** — use the OpenAI-compatible endpoint at `POST /v1/chat/completions`
with `stream=True`. Works with the OpenAI Python SDK, any chat UI, or a raw `httpx`/`requests` call:

```python
from openai import OpenAI

client = OpenAI(api_key="ab_…", base_url="http://localhost:4100")
stream = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "Tell me a joke"}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="", flush=True)
```

**`Client.stream(messages, ...) → Iterator[str]`** — makes one buffered `chat()` call and yields
the text in small chunks. Useful when you want full routing metadata (`res.model`,
`res.routing_decision`, etc.) alongside a streaming-style emit:

```python
for chunk in arbr.stream("Explain quantum entanglement simply"):
    print(chunk, end="", flush=True)
```

Use the OpenAI-compat endpoint when you need real token-by-token delivery or are integrating with
chat UIs. Use `stream()` when you want the routing metadata the OpenAI endpoint doesn't expose.

### `Client.status() → dict`

Healthcheck against `GET /api/status` — `demoMode`, `liveProviders`, `defaultProvider`,
`defaultModel`, `routingMode`, `breachedCaps`.
When the gateway has admin auth enabled (`ARBR_ADMIN_KEY` set server-side), this endpoint
requires a credential — your gateway `api_key` is accepted, so set it and `status()` keeps working.

### `Client.models() → dict`

List every model available on this Arbr instance — `GET /v1/models`.
Uses the same gateway API key as chat calls (no admin key needed).

```python
result = arbr.models()

# Filter and sort by tier / cost
cheap = sorted(
    [m for m in result["data"] if m["tier"] == "light"],
    key=lambda m: m["inputPer1M"],
)
print(cheap[0]["id"], cheap[0]["provider"])  # e.g. "us.amazon.nova-micro-v1:0", "bedrock-nova"
```

Response shape is OpenAI-compatible (`{"object": "list", "data": [...]}`) with Arbr extensions:

| Field | Type | Description |
|---|---|---|
| `id` | str | Model ID — pass as `model=` in chat calls |
| `provider` | str | Underlying provider (`"openai"`, `"bedrock-nova"`, `"anthropic"`, …) |
| `label` | str | Human-readable name |
| `tier` | str | `"light"` / `"mid"` / `"premium"` |
| `inputPer1M` | float | USD per 1M input tokens |
| `outputPer1M` | float | USD per 1M output tokens |

Async counterpart: `await arbr.amodels()`.

### `Client.providers() → dict`

List configured live providers — `GET /v1/providers`.
Returns `{"object": "list", "data": [{"id": ..., "models": [...]}]}`. No credentials exposed.

```python
result = arbr.providers()

for p in result["data"]:
    print(p["id"], "→", len(p["models"]), "models")

# openai       → 2 models
# bedrock-nova → 11 models
# anthropic    → 3 models
```

Async counterpart: `await arbr.aproviders()`.

## Error handling

All failures raise `GatewayError` with `.status`, `.code`, `.retryable`, `.request_id`:

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

## LangChain integration

Two options, by how deep your LangChain usage goes:

**1. Full `BaseChatModel` (recommended for LangChain/LangGraph apps)** — requires the extra:

```python
from arbr_client import create_client
from arbr_client.langchain import ArbrChatModel

client = create_client("http://localhost:4100", application="my-app")
llm = ArbrChatModel(client=client, model_name="auto", max_tokens=1024)

chain = my_prompt | llm           # full Runnable compatibility:
await chain.ainvoke({...})        # pipes, async, batching, callbacks
```

**2. Zero-dep duck-typed adapter** — when you don't want a langchain-core dependency:

```python
from arbr_client import as_langchain_model
llm = as_langchain_model(client, workflow="answer-drafting")
msg = llm.invoke(messages)        # .invoke()/.ainvoke(); AIMessage-shaped result
```

Out of gateway scope either way: tool calling / `with_structured_output`, embeddings, and
token-level streaming — keep those on direct provider SDKs.

## Gradual rollout pattern

Gate the swap at your app's LLM factory so nothing else changes:

```python
def get_llm():
    if os.environ.get("ARBR_GATEWAY_URL"):
        return ArbrChatModel(client=_arbr_client(), model_name=settings.llm_model)
    return build_direct_provider_model()   # unchanged path
```

Unset `ARBR_GATEWAY_URL` to revert instantly.

## License

MIT
