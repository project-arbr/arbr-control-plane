# Changelog

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
