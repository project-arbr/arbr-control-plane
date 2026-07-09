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

| Value | Providers / models |
|-------|--------------------|
| `True` | `openai`, `deepseek`, `groq`, `xai`, `moonshot`, `litellm` (all proxy tools natively); Amazon Nova models on Bedrock (`nova-lite`, `nova-micro`, `nova-pro`) |
| `False` | `gemini`, `anthropic`, DeepSeek R1 on Bedrock (`us.deepseek.r1-v1:0`), GLM, Llama, and other non-Nova Bedrock models |

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
