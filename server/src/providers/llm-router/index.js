// Vendored LLM router — a thin LangChain factory unifying providers.
//
// ORIGIN: copied from @gyde/llm-router (Arbr/packages/llm-router/js) and made
// standalone for the Arbr Control Plane so this service has no monorepo
// dependency. Change from the original: added a direct "anthropic" (Claude)
// adapter alongside gemini / bedrock-nova / openai; added generic OpenAI-compat
// handler for deepseek / moonshot / xai / groq (any provider with a baseURL).
//
// Design notes:
// - Provider SDKs are loaded lazily — the router only requires a provider's
//   adapter when the caller configures that provider.
// - complete() is the 80% convenience API. getModel() is the escape hatch
//   returning the raw LangChain model (for streaming, tool calls, etc.).
// - Messages accept BOTH plain { role, content } objects AND LangChain
//   BaseMessage instances. We normalize internally.

const SUPPORTED_PROVIDERS = ["gemini", "bedrock-nova", "openai", "anthropic", "deepseek", "moonshot", "xai", "groq"];

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
    if (!SUPPORTED_PROVIDERS.includes(id)) {
      throw new Error(
        `createRouter: unknown provider "${id}". Supported: ${SUPPORTED_PROVIDERS.join(", ")}`
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

// Claude 4.x (Opus 4.8 / 4.7) reject temperature / top_p / budget_tokens with a
// 400. Detect those model ids so the anthropic adapter can omit temperature.
function rejectsSamplingParams(modelId) {
  return /opus-4-(7|8)/.test(modelId || "");
}

function loadProviderModel(providerId, cfg, { temperature, maxTokens }) {
  const t = temperature != null ? temperature : (cfg.temperature != null ? cfg.temperature : 0.3);
  const mx = maxTokens != null ? maxTokens : (cfg.maxTokens != null ? cfg.maxTokens : 1024);
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
    return new ChatBedrockConverse({
      model: cfg.model,
      region: cfg.region,
      credentials: cfg.credentials, // {accessKeyId, secretAccessKey} — caller's responsibility
      temperature: t,
      maxTokens: mx,
    });
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
  return messages.map((m) => {
    const role = (m.role || "user").toLowerCase();
    if (role === "system") return new SystemMessage(m.content);
    if (role === "assistant" || role === "ai") return new AIMessage(m.content);
    return new HumanMessage(m.content);
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
  const meta = (response && (response.usage_metadata
    || (response.response_metadata && response.response_metadata.usage))) || {};
  return {
    inputTokens:  meta.input_tokens  || meta.inputTokens  || meta.prompt_tokens     || undefined,
    outputTokens: meta.output_tokens || meta.outputTokens || meta.completion_tokens || undefined,
    totalTokens:  meta.total_tokens  || meta.totalTokens                            || undefined,
  };
}

module.exports = { createRouter, SUPPORTED_PROVIDERS };
