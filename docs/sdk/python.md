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
