# Changelog

## 0.6.1 (2026-08-17)

- **Typing**: ship a `py.typed` marker (PEP 561) so downstream type checkers (mypy, pyright) honor the SDK's inline type hints in consuming projects. Packaging-only — no API changes. Thanks to @govardhanreddyg2005-byte (#304).

## 0.6.0 (2026-08-15)

- **Usage analytics** — read-only, authenticated by a **read token** (an API key of kind `read`, created in the console under Settings → API keys), not the gateway key. A read token is scoped to one application (+ optional user) and cannot run inference, so it's safe to embed in a partner app or per-tenant dashboard. Configure with `create_client(read_token=...)` or `$ARBR_READ_TOKEN`.
  - `usage_overview()` / `ausage_overview()` — headline stats: cost, requests, tokens, success rate, prompt-cache reuse + savings (`GET /v1/usage/overview`).
  - `usage_timeseries(bucket)` / `ausage_timeseries(bucket)` — cost/request trend, `bucket` ∈ `"hour" | "day" | "month"` (`GET /v1/usage/timeseries`).
  - `usage_by_model()` / `ausage_by_model()` — spend + usage by model (`GET /v1/usage/by-model`).
  - `usage_scope()` / `ausage_scope()` — echo the token's own scope (`GET /v1/usage/scope`).
- **`ChatResponse` now carries `finish_reason`** (`"stop" | "length" | "tool_calls" | "content_filter"`) and an optional **`warning`** — so you can tell a deliberately short answer from one truncated by `max_tokens` (e.g. a reasoning model that spent the whole budget on internal thinking and returned no text).

## 0.5.0 (2026-07-13)

- **`embeddings()` / `aembeddings()`** — generate vector embeddings via `POST /v1/embeddings`. OpenAI-compatible wire format. Dispatches to Gemini (`gemini-embedding-001`) or any OpenAI-compat provider (`text-embedding-3-small`, etc.) with full observability parity to chat.

## 0.4.0 (2026-06-30)

- **`Usage` dataclass**: gains `cached_read_tokens` and `cache_write_tokens` — populated from the gateway's prompt-cache token breakdown when Anthropic or OpenAI caching is active (`res.usage.cached_read_tokens`, `res.usage.cache_write_tokens`).
- **Docs**: updated README with difficulty-aware routing behaviour, cache token fields, and per-user spend / realised-savings analytics.

## 0.3.1 (2026-06-26)

- `task_types()` / `atask_types()` — list all supported task types with tier and description (`GET /v1/task-types`). Pass the returned `id` as `task_type` in `chat()` calls to enable smart routing.

## 0.2.0 (2026-06-19)

- `models()` / `amodels()` — list all models available on this Arbr instance (`GET /v1/models`). Returns OpenAI-compatible format with Arbr extensions: `provider`, `label`, `tier`, `inputPer1M`, `outputPer1M`.
- `providers()` / `aproviders()` — list configured live providers and their model IDs (`GET /v1/providers`). No credentials exposed.

## 0.1.0 (2026-06-17)

Initial release.

- `create_client()` — configurable gateway client (base URL, default metadata, timeout, retries). Env fallbacks: `ARBR_GATEWAY_URL`, `ARBR_API_KEY`.
- `chat()` / `achat()` — sync + async routed completions via `POST /v1/chat`; accepts a bare string, `{"role","content"}` dicts, or LangChain message objects; returns a frozen `ChatResponse` dataclass (`text`, `usage`, `model`, `model_requested`, `provider`, `routing_decision`, `classified_by`, `cache_hit`, `request_id`, `raw`).
- `stream()` / `astream()` — buffered shim yielding text chunks with full routing metadata on the `ChatResponse` return value.
- Real SSE streaming available via the OpenAI-compatible endpoint (`POST /v1/chat/completions` with `stream=True`) — use the OpenAI Python SDK pointed at the gateway URL.
- `status()` / `astatus()` — gateway healthcheck (`GET /api/status`).
- `GatewayError` — typed errors with `status`, `code`, `request_id`, `retryable`; retries with exponential backoff + jitter on network errors, timeouts, 429, and 5xx.
- `as_langchain_model()` — zero-dependency duck-typed adapter (`.invoke()`/`.ainvoke()`, callable for simple `prompt | model` chains).
- `arbr_client.langchain.ArbrChatModel` — optional real `BaseChatModel` integration (`pip install arbr-client[langchain]`): full Runnable compatibility for LangChain/LangGraph apps.
- Zero runtime dependencies (stdlib only); Python ≥ 3.11.
