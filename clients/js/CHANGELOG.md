# Changelog

## 0.5.0 (2026-07-13)

- **`embeddings()`** — generate vector embeddings via `POST /v1/embeddings`. OpenAI-compatible wire format (`{ model, input, dimensions? }`). Dispatches to Gemini (`gemini-embedding-001`) or any OpenAI-compat provider (`text-embedding-3-small`, etc.) with full observability parity to chat.
- **TypeScript**: added `EmbeddingsRequest`, `EmbeddingObject`, `EmbeddingsResponse` interfaces; `embeddings()` on `Client`.

## 0.4.0 (2026-06-30)

- **TypeScript**: `Usage` interface gains `cachedReadTokens` and `cacheWriteTokens` — now typed for prompt-cache token breakdown returned by the gateway when Anthropic or OpenAI prompt caching is active.
- **Docs**: updated README with difficulty-aware routing behaviour, cache token fields, and per-user spend / realised-savings analytics.

## 0.3.1 (2026-06-26)

- `taskTypes()` — list all supported task types with tier and description (`GET /v1/task-types`). Pass the returned `id` as `taskType` in `chat()` calls to enable smart routing without manual classification.
- TypeScript: added `TaskType`, `TaskTypesResponse` interfaces.

## 0.2.0 (2026-06-19)

- `models()` — list all models available on this Arbr instance (`GET /v1/models`). Returns OpenAI-compatible format with Arbr extensions: `provider`, `label`, `tier`, `inputPer1M`, `outputPer1M`. Works with the OpenAI Node.js SDK `openai.models.list()` too.
- `providers()` — list configured live providers and their model IDs (`GET /v1/providers`). No credentials exposed.
- TypeScript: added `ArbrModel`, `ModelsResponse`, `ArbrProvider`, `ProvidersResponse` interfaces.

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
