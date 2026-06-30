// Type definitions for arbr-client.
// Plain-JS source; these typings are hand-maintained alongside src/index.js.

export type Role = "system" | "user" | "assistant";

export interface ChatMessage {
  role?: Role | string;
  content: string | Array<string | { text?: string }>;
}

/** Anything with a LangChain-style _getType() is also accepted. */
export interface LangChainishMessage {
  _getType(): string;
  content: unknown;
}

export type MessagesInput =
  | string
  | Array<ChatMessage | LangChainishMessage | string>;

export type RoutingDecision =
  | "passthrough"
  | "explicit"
  | "rule"
  | "auto"
  | "ai"
  | "cache"
  | "fallback";

export type ClassifiedBy = "provided" | "keyword" | "ai";

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** Tokens served from the provider's prompt cache (billed at cache-read rate). */
  cachedReadTokens?: number;
  /** Tokens written to the provider's prompt cache (billed at cache-write rate). */
  cacheWriteTokens?: number;
}

export interface ChatResponse {
  requestId: string;
  /** The model that actually served the request. */
  model: string;
  /** What the caller asked for — the pinned model id, or "auto". */
  modelRequested: string;
  provider: string;
  routingDecision: RoutingDecision;
  classifiedBy: ClassifiedBy;
  cacheHit: boolean;
  text: string;
  usage?: Usage;
}

export interface StatusResponse {
  demoMode: boolean;
  liveProviders: string[];
  defaultProvider: string | null;
  defaultModel: string | null;
  routingMode: "off" | "guardrail" | "ai";
  breachedCaps: number;
}

export type ModelTier = "light" | "mid" | "premium";

export interface ArbrModel {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  /** Underlying Arbr provider (e.g. "openai", "bedrock-nova", "anthropic"). */
  provider: string;
  label: string;
  tier: ModelTier;
  /** USD per 1M input tokens. */
  inputPer1M: number;
  /** USD per 1M output tokens. */
  outputPer1M: number;
  /** Whether this model supports tool/function calling on /v1/chat/completions. */
  toolCallSupported: boolean;
}

export interface ModelsResponse {
  object: "list";
  data: ArbrModel[];
}

export interface ArbrProvider {
  id: string;
  /** Model IDs registered against this provider. */
  models: string[];
}

export interface ProvidersResponse {
  object: "list";
  data: ArbrProvider[];
}

export type TaskTier = "light" | "mid" | "premium";

export interface TaskType {
  /** Pass this value as `taskType` in chat() calls to enable smart routing. */
  id: string;
  tier: TaskTier;
  label: string;
  description: string;
}

export interface TaskTypesResponse {
  object: "list";
  data: TaskType[];
}

export interface ClientOptions {
  /** Gateway origin, e.g. "http://localhost:4100". Falls back to ARBR_GATEWAY_URL. */
  baseUrl?: string;
  /** Gateway API key ("ab_…", from Settings → API keys). Falls back to ARBR_API_KEY. Binds attribution server-side. */
  apiKey?: string;
  /** Default attribution metadata merged into every call. */
  application?: string;
  workflow?: string;
  department?: string;
  userId?: string;
  /** Per-attempt timeout in ms (default 60_000). */
  timeoutMs?: number;
  /** Retries on network errors / timeouts / 429 / 5xx (default 2). */
  retries?: number;
  /** Injectable fetch (tests, custom agents). Defaults to global fetch. */
  fetch?: typeof fetch;
}

export interface ChatRequest {
  messages: MessagesInput;
  /** Omit or pass "auto" to let the gateway's router decide. */
  model?: string;
  provider?: string;
  taskType?: string;
  temperature?: number;
  maxTokens?: number;
  application?: string;
  workflow?: string;
  department?: string;
  userId?: string;
  /** Per-call overrides. */
  timeoutMs?: number;
  retries?: number;
  signal?: AbortSignal;
}

export type ErrorCode =
  | "bad_request"
  | "demo_mode"
  | "provider_error"
  | "invalid_api_key"
  | "budget_exceeded"
  | "rate_limited"
  | "http_error"
  | "network"
  | "timeout"
  | "aborted"
  | "invalid_input";

export class GatewayError extends Error {
  status: number;
  code: ErrorCode;
  requestId?: string;
  retryable: boolean;
  cause?: unknown;
}

export interface Client {
  /** One routed completion via POST /v1/chat. */
  chat(opts: ChatRequest): Promise<ChatResponse>;
  /**
   * Async-iterator interface. The gateway is non-streaming today, so this is a
   * buffered call yielded in chunks; the generator's return value is the full
   * ChatResponse.
   */
  stream(opts: ChatRequest): AsyncGenerator<{ text: string }, ChatResponse>;
  /** Gateway healthcheck — GET /api/status. */
  status(opts?: { signal?: AbortSignal }): Promise<StatusResponse>;
  /** List all models available on this Arbr instance — GET /v1/models. */
  models(opts?: { signal?: AbortSignal }): Promise<ModelsResponse>;
  /** List configured live providers — GET /v1/providers. */
  providers(opts?: { signal?: AbortSignal }): Promise<ProvidersResponse>;
  /** List all supported task types with tier and description — GET /v1/task-types. */
  taskTypes(opts?: { signal?: AbortSignal }): Promise<TaskTypesResponse>;
  baseUrl: string;
}

export function createClient(options?: ClientOptions): Client;

export interface AiMessageShape {
  content: string;
  usage_metadata: { input_tokens: number; output_tokens: number; total_tokens: number };
  response_metadata: {
    model: string;
    provider: string;
    routingDecision: RoutingDecision;
    classifiedBy: ClassifiedBy;
    modelRequested: string;
    requestId: string;
    gateway: true;
  };
  additional_kwargs: Record<string, never>;
  _getType(): "ai";
}

export interface LangChainishModel {
  invoke(messages: MessagesInput): Promise<AiMessageShape>;
  stream(messages: MessagesInput): AsyncGenerator<{ content: string; _getType(): "ai" }>;
}

/**
 * Wrap a client as a minimal LangChain-style chat model (duck-typed — no
 * LangChain dependency) for factory/chokepoint integrations.
 */
export function asLangChainModel(
  client: Client,
  meta?: Omit<ChatRequest, "messages" | "signal">
): LangChainishModel;
