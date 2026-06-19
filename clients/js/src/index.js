// Official JS client for the AI control-plane gateway.
//
// Zero dependencies — Node >= 18 (global fetch). CommonJS, no build step.
//
// The gateway owns provider keys, routing policy, logging and cost attribution;
// this client is a thin, robust pipe to it:
//
//   const { createClient } = require("arbr-client");
//   const arbr = createClient({ baseUrl: "http://localhost:4100", application: "my-app" });
//   const res = await arbr.chat({ messages: "Summarise this ticket…" });
//   // res.text, res.model, res.routingDecision ("explicit" | "rule" | "ai" | …)

"use strict";

// ── errors ────────────────────────────────────────────────────────────────────

/**
 * Typed gateway error.
 * code: "bad_request" | "demo_mode" | "provider_error" | "http_error"
 *     | "network" | "timeout" | "aborted" | "invalid_input"
 */
class GatewayError extends Error {
  constructor(message, { status = 0, code = "http_error", requestId, retryable = false, cause } = {}) {
    super(message);
    this.name = "GatewayError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.retryable = retryable;
    if (cause) this.cause = cause;
  }
}

function invalid(message) {
  return new GatewayError(message, { code: "invalid_input", status: 0, retryable: false });
}

// ── message normalization ─────────────────────────────────────────────────────

// Flatten string | array-of-parts | anything → string.
function contentToString(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c === "string" ? c : c && c.text ? c.text : "")).join("");
  }
  return content == null ? "" : String(content);
}

// Accepts: a bare string, plain {role, content} objects, or duck-typed
// LangChain BaseMessages (anything with _getType()). Returns gateway shape.
function normalizeMessages(messages) {
  if (typeof messages === "string") {
    return [{ role: "user", content: messages }];
  }
  const arr = Array.isArray(messages) ? messages : [messages];
  if (arr.length === 0) throw invalid("`messages` must not be empty");
  return arr.map((m, i) => {
    if (m == null) throw invalid(`message at index ${i} is null/undefined`);
    if (typeof m._getType === "function") {
      const t = m._getType(); // "system" | "human" | "ai" | …
      const role = t === "system" ? "system" : t === "ai" ? "assistant" : "user";
      return { role, content: contentToString(m.content) };
    }
    if (typeof m === "string") return { role: "user", content: m };
    const role = m.role || "user";
    return { role, content: contentToString(m.content) };
  });
}

// ── retry / timeout plumbing ──────────────────────────────────────────────────

const RETRY_BASE_MS = 250;
const RETRY_CAP_MS = 4000;

function backoffDelay(attempt) {
  const exp = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** attempt);
  return Math.round(exp / 2 + Math.random() * (exp / 2)); // half fixed, half jitter
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One HTTP attempt with a per-attempt timeout, composed with the caller's signal.
async function attemptFetch(fetchImpl, url, init, { timeoutMs, signal }) {
  if (signal?.aborted) {
    throw new GatewayError("request aborted by caller", { code: "aborted", retryable: false });
  }
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
  const onCallerAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onCallerAbort, { once: true });
  try {
    return await fetchImpl(url, { ...init, signal: ctrl.signal });
  } catch (err) {
    if (timedOut) {
      throw new GatewayError(`request timed out after ${timeoutMs}ms`, {
        code: "timeout", retryable: true, cause: err,
      });
    }
    if (signal?.aborted) {
      throw new GatewayError("request aborted by caller", { code: "aborted", retryable: false, cause: err });
    }
    throw new GatewayError(`network error: ${err?.message || err}`, {
      code: "network", retryable: true, cause: err,
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onCallerAbort);
  }
}

async function parseBody(res) {
  try { return await res.json(); } catch { return null; }
}

function errorFromResponse(res, body) {
  const status = res.status;
  const message = (body && (body.message || body.error)) || `gateway responded ${status}`;
  let code = "http_error";
  if (body && body.error === "demo_mode") code = "demo_mode";
  else if (body && body.error === "provider_error") code = "provider_error";
  else if (body && body.error === "invalid_api_key") code = "invalid_api_key";
  else if (body && body.error === "budget_exceeded") code = "budget_exceeded";
  else if (body && body.error === "rate_limited") code = "rate_limited";
  else if (status === 400) code = "bad_request";
  // budget_exceeded is a 429 but retrying won't help until the window rolls past.
  const retryable = code !== "budget_exceeded" && (status === 429 || status >= 500);
  return new GatewayError(message, { status, code, requestId: body?.requestId, retryable });
}

// Full request with retries (network / timeout / 429 / 5xx only).
async function requestWithRetries(fetchImpl, url, init, { timeoutMs, retries, signal }) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(backoffDelay(attempt - 1));
    let res;
    try {
      res = await attemptFetch(fetchImpl, url, init, { timeoutMs, signal });
    } catch (err) {
      lastErr = err;
      if (err.retryable && attempt < retries) continue;
      throw err;
    }
    const body = await parseBody(res);
    if (res.ok) return body ?? {};
    const gerr = errorFromResponse(res, body);
    lastErr = gerr;
    if (gerr.retryable && attempt < retries) continue;
    throw gerr;
  }
  throw lastErr; // unreachable in practice
}

// ── the client ────────────────────────────────────────────────────────────────

const STREAM_CHUNK_CHARS = 24;

/**
 * Create a gateway client.
 * options: { baseUrl, application, workflow, department, userId,
 *            timeoutMs = 60000, retries = 2, fetch = globalThis.fetch }
 */
function createClient(options = {}) {
  const baseUrl = String(options.baseUrl || process.env.ARBR_GATEWAY_URL || "").replace(/\/+$/, "");
  if (!baseUrl) {
    throw invalid("`baseUrl` is required (or set ARBR_GATEWAY_URL)");
  }
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw invalid("global fetch not found — Node >= 18 required (or pass options.fetch)");
  }
  const defaults = {
    application: options.application,
    workflow: options.workflow,
    department: options.department,
    userId: options.userId,
  };
  const timeoutMs = options.timeoutMs ?? 60_000;
  const retries = Math.max(0, options.retries ?? 2);
  // Gateway API key (Settings → API keys). Binds attribution server-side.
  const apiKey = options.apiKey || process.env.ARBR_API_KEY || null;
  const baseHeaders = { "Content-Type": "application/json" };
  if (apiKey) baseHeaders.Authorization = `Bearer ${apiKey}`;

  /**
   * One routed completion. `model` omitted or "auto" → the gateway's router
   * decides (rules → automated routing → default); an explicit model whose
   * provider is connected is honored as-is.
   */
  async function chat(opts = {}) {
    const { messages, signal, ...rest } = opts;
    if (messages == null) throw invalid("`messages` is required");
    const body = {
      ...defaults,
      ...rest,
      messages: normalizeMessages(messages),
    };
    return requestWithRetries(
      fetchImpl,
      `${baseUrl}/v1/chat`,
      {
        method: "POST",
        headers: baseHeaders,
        body: JSON.stringify(body),
      },
      { timeoutMs: opts.timeoutMs ?? timeoutMs, retries: opts.retries ?? retries, signal }
    );
  }

  /**
   * Async-iterator interface. NOTE: the gateway is non-streaming today, so this
   * performs ONE buffered chat() call and yields the answer in small chunks —
   * near-streaming UX, not token-by-token. The generator's return value is the
   * full chat response.
   */
  async function* stream(opts = {}) {
    const res = await chat(opts);
    const text = res.text || "";
    for (let i = 0; i < text.length; i += STREAM_CHUNK_CHARS) {
      yield { text: text.slice(i, i + STREAM_CHUNK_CHARS) };
    }
    return res;
  }

  /** Gateway healthcheck — GET /api/status. */
  async function status({ signal } = {}) {
    return requestWithRetries(
      fetchImpl,
      `${baseUrl}/api/status`,
      { method: "GET", headers: baseHeaders },
      { timeoutMs, retries, signal }
    );
  }

  /**
   * List all models available on this Arbr instance — GET /v1/models.
   * Returns an OpenAI-compatible list object with Arbr extensions on each entry:
   * `id`, `provider`, `label`, `tier`, `inputPer1M`, `outputPer1M`.
   */
  async function models({ signal } = {}) {
    return requestWithRetries(
      fetchImpl,
      `${baseUrl}/v1/models`,
      { method: "GET", headers: baseHeaders },
      { timeoutMs, retries, signal }
    );
  }

  /**
   * List configured live providers — GET /v1/providers.
   * Returns `{ object: "list", data: [{ id, models: string[] }] }`.
   * No credentials or keys are exposed.
   */
  async function providers({ signal } = {}) {
    return requestWithRetries(
      fetchImpl,
      `${baseUrl}/v1/providers`,
      { method: "GET", headers: baseHeaders },
      { timeoutMs, retries, signal }
    );
  }

  return { chat, stream, status, models, providers, baseUrl };
}

// ── LangChain-style adapter (duck-typed; no LangChain dependency) ─────────────

/**
 * Wrap a client as a minimal LangChain-style chat model for factory/chokepoint
 * integrations: `.invoke(messages)` returns an AIMessage-shaped object
 * ({ content, usage_metadata, response_metadata }), `.stream(messages)` yields
 * chunks with `.content`. `meta` is merged into every call (workflow, taskType,
 * provider, model, temperature, maxTokens…).
 */
function asLangChainModel(client, meta = {}) {
  function toAiMessage(res) {
    const u = res.usage || {};
    return {
      content: res.text || "",
      usage_metadata: {
        input_tokens: u.inputTokens || 0,
        output_tokens: u.outputTokens || 0,
        total_tokens: u.totalTokens || 0,
      },
      response_metadata: {
        model: res.model,
        provider: res.provider,
        routingDecision: res.routingDecision,
        classifiedBy: res.classifiedBy,
        modelRequested: res.modelRequested,
        requestId: res.requestId,
        gateway: true,
      },
      additional_kwargs: {},
      _getType: () => "ai",
    };
  }

  return {
    async invoke(messages) {
      const res = await client.chat({ ...meta, messages });
      return toAiMessage(res);
    },
    async *stream(messages) {
      const res = await client.chat({ ...meta, messages });
      const text = res.text || "";
      for (let i = 0; i < text.length; i += STREAM_CHUNK_CHARS) {
        yield { content: text.slice(i, i + STREAM_CHUNK_CHARS), _getType: () => "ai" };
      }
    },
  };
}

module.exports = { createClient, asLangChainModel, GatewayError };
