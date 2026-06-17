# Changelog

## 0.1.0 (2026-06-17)

Initial release.

- `createClient()` — configurable gateway client (base URL, default metadata, timeout, retries, injectable fetch). Env fallbacks: `ARBR_GATEWAY_URL`, `ARBR_API_KEY`.
- `chat()` — one call to `POST /v1/chat`; accepts plain `{role, content}` messages, LangChain-style message objects, or a bare string; returns the gateway's full routed response (`text`, `usage`, `model`, `modelRequested`, `provider`, `routingDecision`, `classifiedBy`, `cacheHit`, `requestId`).
- `stream()` — async-iterator interface; buffered shim on `POST /v1/chat` yielding text chunks with full routing metadata on the return value.
- Real SSE streaming available via the OpenAI-compatible endpoint (`POST /v1/chat/completions` with `stream: true`) — use any OpenAI-SDK-compatible client pointed at the gateway URL.
- `status()` — gateway healthcheck (`GET /api/status`).
- `asLangChainModel()` — zero-dependency duck-typed model object (`.invoke()` / `.stream()`) for factory/chokepoint integrations.
- `GatewayError` — typed errors with `status`, `code`, `requestId`, `retryable`.
- Retries with exponential backoff + jitter on network errors, 429, and 5xx; per-attempt timeout via `AbortController`; caller `AbortSignal` support.
