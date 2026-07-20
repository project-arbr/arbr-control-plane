# Python SDK — arbr-client

Official zero-dependency Python client. Python ≥ 3.11, stdlib only. Sync and async.

## Install

```sh
pip install arbr-client                # core (zero deps)
pip install "arbr-client[langchain]"   # + real BaseChatModel for LangChain/LangGraph
```

## Quick start

```python
from arbr_client import create_client

arbr = create_client(
    "http://localhost:4100",   # or set ARBR_GATEWAY_URL
    application="my-app",
)

res = arbr.chat("Summarise this ticket: …", model="auto", max_tokens=300)
print(res.text)
print(res.model, res.routing_decision)  # "gpt-4o-mini", "ai"
```

Async (FastAPI, LangGraph, etc.):

```python
res = await arbr.achat("Summarise this ticket: …", model="auto")
```

## `create_client(base_url=None, *, ...) → Client`

```python
arbr = create_client(
    base_url="http://localhost:4100",  # fallback: $ARBR_GATEWAY_URL
    application="support-chat",
    workflow="ticket-triage",
    api_key="ab_…",                    # fallback: $ARBR_API_KEY
    timeout_s=60.0,
    retries=2,
)
```

`base_url` and `api_key` fall back to `$ARBR_GATEWAY_URL` and `$ARBR_API_KEY`.

## Team attribution — identifying developers

When a team shares one gateway key, pass `user_id` to attribute each developer's requests
separately. Set it at the client level so every call is attributed automatically:

```python
import os
from arbr_client import create_client

arbr = create_client(
    application="opencode",
    user_id=os.environ.get("ARBR_USER_ID"),   # e.g. "alice@company.com"
    department="engineering",                  # optional team grouping
)
```

Or override per-call when a single client instance serves multiple users:

```python
res = arbr.chat("…", user_id=current_user.email)
```

Each developer's spend and requests appear separately in **Overview → Applications → opencode**
with no additional key management needed.

## `Client.chat(messages, *, ...) → ChatResponse`

```python
res = arbr.chat(
    messages=[
        {"role": "system", "content": "You are a support agent."},
        {"role": "user",   "content": "How do I reset my password?"},
    ],
    model="auto",
    task_type="support response",
    max_tokens=512,
    workflow="support-chat",
)
```

`messages` accepts: bare string, `{"role","content"}` dicts, or LangChain message objects.

`ChatResponse` is a frozen dataclass:

```python
res.text              # "Click Settings > Security > Reset password."
res.model             # "gpt-4o-mini"
res.model_requested   # "auto"
res.provider          # "openai"
res.routing_decision  # "rule" | "explicit" | "auto" | "ai" | "cache" | "fallback" | "budget"
res.classified_by     # "provided" | "keyword" | "ai"
res.cache_hit         # False
res.request_id        # "a1b2c3..."
res.usage             # Usage(input_tokens=22, output_tokens=9, total_tokens=31)
res.raw               # the unmodified gateway payload dict
```

## Async methods

```python
res = await arbr.achat(messages, **kwargs)       # async chat
async for chunk in arbr.astream(messages):       # async stream
    print(chunk, end="", flush=True)
status = await arbr.astatus()
```

All async methods run the blocking implementation in a worker thread via `asyncio.to_thread`.

## `Client.stream(messages, ...) → Iterator[str]`

Buffered shim — one `chat()` call, yields text in chunks. Use the [OpenAI-compat endpoint](/gateway/openai-compat) for real token-by-token SSE.

```python
for chunk in arbr.stream("Tell me a story"):
    print(chunk, end="", flush=True)
```

## `Client.models() → dict`

Returns all models available on this Arbr instance — only models whose provider is currently connected are included. Each entry includes a `toolCallSupported` flag so you can disable Search / function-calling UI for models that don't support it.

```python
result = arbr.models()
# result["data"] is a list of dicts:
# {
#   "id": "gpt-4o",
#   "provider": "openai",
#   "label": "GPT-4o",
#   "tier": "premium",        # "light" | "mid" | "premium"
#   "inputPer1M": 2.5,        # USD per 1M input tokens
#   "outputPer1M": 10.0,
#   "toolCallSupported": True # False for Gemini, DeepSeek R1, GLM, etc.
# }

# Async variant:
result = await arbr.amodels()

# Filter to models that support tool/function calling:
tool_models = [m for m in result["data"] if m["toolCallSupported"]]

# Guard before enabling Search toggle:
models_by_id = {m["id"]: m for m in result["data"]}
if not models_by_id.get("us.deepseek.r1-v1:0", {}).get("toolCallSupported"):
    print("Search disabled for DeepSeek R1")
```

**`toolCallSupported` rules:**

`True` for `openai`, `deepseek`, `groq`, `xai`, `moonshot`, `litellm` — these proxy tools
natively. For Bedrock (`provider: "bedrock-nova"`), it's a pattern-matched allowlist against the
model id, not a blanket Nova-only rule:

| Value | Bedrock models |
|-------|--------------------|
| `True` | Amazon Nova (`nova-lite`, `nova-micro`, `nova-pro`, `nova-premier`), Claude 3.x (Haiku, Sonnet, Opus, 3.5, 3.7), Llama 3.x, Command R / R+, Mistral Large / Small, AI21 Jamba, Writer Palmyra X5, Kimi K2.5 |
| `False` | Everything else on Bedrock not matched above (e.g. Mistral 7B, Mixtral 8x7B, DeepSeek R1 (`us.deepseek.r1-v1:0`)) |

`False` outright for `gemini` and direct `anthropic` (not proxied through Bedrock's Converse API).
See `BEDROCK_TOOL_PATTERNS` in `server/src/gateway/capabilities.js` for the exact list.

## `Client.task_types() → dict`

Returns all supported task types with routing tier and description. Use the `id` values as `task_type` in `chat()` calls to activate smart routing.

```python
result = arbr.task_types()
# result["data"] is a list of dicts:
# [{"id": "coding", "tier": "mid", "label": "Code generation", "description": "…"}, ...]

# Async variant:
result = await arbr.atask_types()

# Example: pick a task type and use it
task_type = "document analysis"   # tier: premium → routes to most capable model
res = arbr.chat("Summarise and extract key clauses from this contract: …", task_type=task_type)
```

**Tier routing behaviour:**

| Tier | Routed to | When to use |
|------|-----------|-------------|
| `light` | Cheapest fast model | FAQ, translation, classification, autocomplete |
| `mid` | Balanced model | Code generation, support replies, extraction |
| `premium` | Most capable model | Reasoning, architecture design, security audit |

## `Client.embeddings(input, *, model, ...) → dict`

Generate vector embeddings — `POST /v1/embeddings`. OpenAI-compatible wire format, same observability as chat.

```python
# Single input
res = arbr.embeddings("Summarise the customer's pain points", model="gemini-embedding-001", dimensions=768)
vector = res["data"][0]["embedding"]  # list[float] of length 768

# Batch
res = arbr.embeddings(
    ["sentence one", "sentence two", "sentence three"],
    model="gemini-embedding-001",
    dimensions=768,
)
vectors = [d["embedding"] for d in res["data"]]  # list[list[float]]

# Async
res = await arbr.aembeddings(texts, model="gemini-embedding-001", dimensions=768)
```

**Parameters:**

| Parameter | Required | Description |
|---|---|---|
| `input` | yes | String or list of strings to embed (positional). |
| `model` | yes | Embedding model ID. Gemini: `"gemini-embedding-001"`. OpenAI: `"text-embedding-3-small"`, etc. |
| `dimensions` | no | Truncate output to this many dimensions. For Gemini this becomes `outputDimensionality`. **Must match your vector index size.** |
| `timeout_s`, `retries` | no | Same per-call overrides as `chat()`. |

**Response dict:**
```python
{
    "object": "list",
    "data": [{"object": "embedding", "index": 0, "embedding": [0.012, -0.045, …]}],
    "model": "gemini-embedding-001",
    "usage": {"prompt_tokens": 8, "total_tokens": 8},
}
```

Works as a drop-in for any OpenAI SDK targeting the gateway:
```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:4100/v1", api_key="ab_…")
resp = client.embeddings.create(model="gemini-embedding-001", input=texts, dimensions=768)
vectors = [d.embedding for d in resp.data]
```

## `Client.status() → dict`

```python
s = arbr.status()
# {"demoMode": False, "liveProviders": ["openai"], "routingMode": "guardrail", ...}
```

## LangChain integration

**Full `BaseChatModel` (recommended for LangChain/LangGraph):**

```python
from arbr_client import create_client
from arbr_client.langchain import ArbrChatModel

client = create_client("http://localhost:4100", application="my-app")
llm = ArbrChatModel(client=client, model_name="auto", max_tokens=1024)

# Full Runnable compatibility
chain = my_prompt | llm
result = await chain.ainvoke({"input": "…"})
```

**Zero-dep duck-typed adapter:**

```python
from arbr_client import as_langchain_model

llm = as_langchain_model(client, workflow="answer-drafting")
msg = llm.invoke(messages)   # .content, .usage_metadata, .response_metadata
```

## Error handling

```python
from arbr_client import GatewayError

try:
    res = arbr.chat("…")
except GatewayError as e:
    print(e.code, e.status, e.retryable, e.request_id)
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

## Gradual rollout pattern

```python
def get_llm():
    if os.environ.get("ARBR_GATEWAY_URL"):
        return ArbrChatModel(client=_arbr_client(), model_name=settings.llm_model)
    return build_direct_provider_model()

# Unset ARBR_GATEWAY_URL to revert instantly.
```
