// Vendored LLM router — a thin LangChain factory unifying providers.
//
// Standalone module for the Arbr Control Plane: a direct "anthropic" (Claude)
// adapter alongside gemini / bedrock-nova / openai, plus a generic OpenAI-compat
// handler for deepseek / moonshot / xai / groq (any provider with a baseURL).
//
// Design notes:
// - Provider SDKs are loaded lazily — the router only requires a provider's
//   adapter when the caller configures that provider.
// - complete() is the 80% convenience API. getModel() is the escape hatch
//   returning the raw LangChain model (for streaming, tool calls, etc.).
// - Messages accept BOTH plain { role, content } objects AND LangChain
//   BaseMessage instances. We normalize internally.

const SUPPORTED_PROVIDERS = ["gemini", "bedrock-nova", "openai", "anthropic", "deepseek", "moonshot", "xai", "groq", "litellm"];

// Output cap applied ONLY when neither the caller nor the provider config specifies
// max_tokens. The old default of 1024 silently truncated normal completions mid-sentence
// (providers reported stop_reason "max_tokens", which the gateway then masked as "stop").
// Kept high so a missing client max_tokens does not cut answers short; clients should still
// pass their own value, and the global maxTokensGuardrail setting clamps the ceiling.
// Override with ARBR_DEFAULT_MAX_TOKENS.
const DEFAULT_MAX_TOKENS = Number(process.env.ARBR_DEFAULT_MAX_TOKENS) || 4096;

function createRouter(options) {
  if (!options || typeof options !== "object") {
    throw new Error("createRouter: options is required");
  }
  const { providers, defaultProvider, fallbackChain = [], onTrace } = options;
  if (!providers || typeof providers !== "object") {
    throw new Error("createRouter: providers map is required");
  }
  if (!defaultProvider || !providers[defaultProvider]) {
    throw new Error(
      `createRouter: defaultProvider "${defaultProvider}" is not in providers map`
    );
  }
  for (const id of Object.keys(providers)) {
    if (!SUPPORTED_PROVIDERS.includes(id) && !providers[id].baseURL) {
      throw new Error(
        `createRouter: unknown provider "${id}" and no baseURL set. Built-in providers: ${SUPPORTED_PROVIDERS.join(", ")}`
      );
    }
  }

  function getModel({ providerOverride, modelOverride, temperature, maxTokens } = {}) {
    const providerId = providerOverride || defaultProvider;
    const cfg = providers[providerId];
    if (!cfg) {
      throw new Error(`getModel: provider "${providerId}" is not configured`);
    }
    const effectiveCfg = modelOverride ? { ...cfg, model: modelOverride } : cfg;
    return loadProviderModel(providerId, effectiveCfg, { temperature, maxTokens });
  }

  async function complete(args) {
    if (!args || !Array.isArray(args.messages) || args.messages.length === 0) {
      throw new Error("complete: messages array is required");
    }
    const order = args.providerOverride
      ? [args.providerOverride]
      : [defaultProvider, ...fallbackChain];

    let lastErr;
    for (const providerId of order) {
      if (!providers[providerId]) continue;
      const baseCfg = providers[providerId];
      const cfg = args.modelOverride ? { ...baseCfg, model: args.modelOverride } : baseCfg;
      const start = Date.now();
      try {
        const model = loadProviderModel(providerId, cfg, {
          temperature: args.temperature,
          maxTokens: args.maxTokens,
        });
        const lcMessages = toLangchainMessages(args.messages);
        const response = await model.invoke(lcMessages);
        const latencyMs = Date.now() - start;
        const result = {
          text: extractText(response),
          providerId,
          modelId: cfg.model,
          latencyMs,
          usage: extractUsage(response),
          finishReason: extractFinishReason(response),
        };
        if (onTrace) {
          try { onTrace({ ...result, ok: true }); } catch { /* swallow trace errors */ }
        }
        return result;
      } catch (err) {
        lastErr = err;
        if (onTrace) {
          try {
            onTrace({
              providerId,
              modelId: cfg.model,
              latencyMs: Date.now() - start,
              ok: false,
              error: String(err),
            });
          } catch { /* swallow */ }
        }
        // try next in fallback chain
      }
    }
    throw new Error(
      `complete: all providers failed. Last error: ${lastErr ? lastErr.message : "unknown"}`
    );
  }

  return { complete, getModel };
}

// ───── provider adapters ──────────────────────────────────────────────────

// Reasoning models that reject temperature/top_p with a ValidationException:
//   - Claude Opus 4.8 / 4.7 (Anthropic)
//   - DeepSeek R1 variants on Bedrock (us.deepseek.r1-v1:0, etc.)
function rejectsSamplingParams(modelId) {
  return /opus-4-(7|8)|deepseek.r1/i.test(modelId || "");
}

function loadProviderModel(providerId, cfg, { temperature, maxTokens }) {
  const t = temperature != null ? temperature : (cfg.temperature != null ? cfg.temperature : 0.3);
  const mx = maxTokens != null ? maxTokens : (cfg.maxTokens != null ? cfg.maxTokens : DEFAULT_MAX_TOKENS);
  if (providerId === "gemini") {
    const { ChatGoogleGenerativeAI } = require("@langchain/google-genai");
    return new ChatGoogleGenerativeAI({
      model: cfg.model,
      apiKey: cfg.apiKey,
      temperature: t,
      maxOutputTokens: mx,
    });
  }
  if (providerId === "bedrock-nova") {
    const { ChatBedrockConverse } = require("@langchain/aws");
    const bedrockParams = {
      model: cfg.model,
      region: cfg.region,
      credentials: cfg.credentials, // {accessKeyId, secretAccessKey} — caller's responsibility
      maxTokens: mx,
    };
    // Reasoning models (DeepSeek R1) reject temperature with a ValidationException.
    if (!rejectsSamplingParams(cfg.model)) bedrockParams.temperature = t;
    return new ChatBedrockConverse(bedrockParams);
  }
  if (providerId === "openai") {
    const { ChatOpenAI } = require("@langchain/openai");
    const opts = { model: cfg.model, apiKey: cfg.apiKey, temperature: t, maxTokens: mx };
    // OPENAI_BASE_URL (via config.baseURL) redirects to a proxy/LiteLLM endpoint.
    if (cfg.baseURL) opts.configuration = { baseURL: cfg.baseURL };
    return new ChatOpenAI(opts);
  }
  if (providerId === "anthropic") {
    const { ChatAnthropic } = require("@langchain/anthropic");
    const params = {
      model: cfg.model,
      apiKey: cfg.apiKey,
      maxTokens: mx,
    };
    // Omit temperature for models that reject sampling params (Opus 4.8 / 4.7).
    if (!rejectsSamplingParams(cfg.model)) {
      params.temperature = t;
    }
    return new ChatAnthropic(params);
  }
  // Generic OpenAI-compatible handler (deepseek, moonshot, xai, groq, …).
  // Any provider whose config carries a baseURL routes here.
  if (cfg.baseURL) {
    const { ChatOpenAI } = require("@langchain/openai");
    return new ChatOpenAI({
      model: cfg.model,
      apiKey: cfg.apiKey,
      configuration: { baseURL: cfg.baseURL },
      temperature: t,
      maxTokens: mx,
    });
  }
  throw new Error(`loadProviderModel: unsupported provider "${providerId}"`);
}

function toLangchainMessages(messages) {
  // Accept either LangChain BaseMessage instances or { role, content } objects.
  // If the first item already has a `_getType` method it's a BaseMessage — pass through.
  if (messages[0] && typeof messages[0]._getType === "function") {
    return messages;
  }
  const { SystemMessage, HumanMessage, AIMessage } = require("@langchain/core/messages");
  // Filter nulls first — a malformed LibreChat multi-turn history can include null entries.
  return messages.filter((m) => m != null).map((m) => {
    const role = (m.role || "user").toLowerCase();
    const content = m.content || "";
    if (role === "system") return new SystemMessage(content);
    // Collapse tool/assistant turns in multi-turn history to a human message so native
    // providers (gemini/bedrock) receive a clean conversation without tool_call artifacts.
    if (role === "tool") return new HumanMessage(`[Search result]: ${content}`);
    if (role === "assistant" || role === "ai") return new AIMessage(content);
    return new HumanMessage(content);
  });
}

function extractText(response) {
  if (!response) return "";
  if (typeof response.content === "string") return response.content;
  if (Array.isArray(response.content)) {
    return response.content
      .map((c) => (typeof c === "string" ? c : (c && c.text) ? c.text : ""))
      .join("");
  }
  return String(response.content == null ? "" : response.content);
}

function extractUsage(response) {
  const um = (response && response.usage_metadata) || {};
  const rm = (response && response.response_metadata && response.response_metadata.usage) || {};
  const d  = um.input_token_details || {};

  // Provider prompt-cache tokens. LangChain standardizes them into input_token_details;
  // fall back to raw provider fields (Anthropic cache_read/creation_input_tokens, OpenAI
  // prompt_tokens_details.cached_tokens). `??` so a real 0 is kept, not skipped.
  const cachedReadTokens =
    d.cache_read
    ?? rm.cache_read_input_tokens
    ?? (rm.prompt_tokens_details && rm.prompt_tokens_details.cached_tokens)
    ?? 0;
  const cacheWriteTokens = d.cache_creation ?? rm.cache_creation_input_tokens ?? 0;

  // LangChain's input_tokens is TOTAL input (incl. cached). Raw OpenAI prompt_tokens is too.
  // Raw Anthropic input_tokens EXCLUDES cache, so add it back to keep a consistent total.
  let inputTokens = um.input_tokens ?? um.inputTokens ?? rm.prompt_tokens;
  if (inputTokens == null && rm.input_tokens != null) {
    inputTokens = rm.input_tokens + (Number(cachedReadTokens) || 0) + (Number(cacheWriteTokens) || 0);
  }
  const outputTokens = um.output_tokens ?? um.outputTokens ?? rm.completion_tokens ?? rm.output_tokens;
  const totalTokens  = um.total_tokens  ?? um.totalTokens  ?? rm.total_tokens;

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cachedReadTokens: Number(cachedReadTokens) || 0,
    cacheWriteTokens: Number(cacheWriteTokens) || 0,
  };
}

// Normalize a provider's native stop/finish reason into an OpenAI finish_reason value
// ("stop" | "length" | "tool_calls" | "content_filter"). Each SDK names the field
// differently: Bedrock Converse → stopReason, Anthropic → stop_reason, OpenAI →
// finish_reason, Gemini → finishReason. Returns undefined when none is present so callers
// can fall back to their own default.
function extractFinishReason(response) {
  const rm = (response && response.response_metadata) || {};
  const ak = (response && response.additional_kwargs) || {};
  const raw = rm.stopReason || rm.stop_reason || rm.finishReason || rm.finish_reason || ak.stop_reason;
  if (!raw) return undefined;
  const s = String(raw).toLowerCase();
  if (s === "max_tokens" || s === "length" || s === "model_length" || s === "max_output_tokens") return "length";
  if (s.includes("tool") || s.includes("function")) return "tool_calls";
  if (s.includes("content") || s === "safety" || s === "recitation" || s === "blocklist") return "content_filter";
  // end_turn, stop, stop_sequence, eos, complete, etc. → normal completion.
  return "stop";
}

module.exports = { createRouter, SUPPORTED_PROVIDERS, extractFinishReason, extractUsage };
