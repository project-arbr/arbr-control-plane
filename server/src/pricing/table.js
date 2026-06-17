// Per-model pricing + tiering. Prices are USD per 1,000,000 tokens (input/output).
// `tier` drives the recommendation engine: "premium" frontier models flagged
// when used for cheap task types; "light" models are the suggested targets.
//
// Verify against provider pricing pages before relying on these for billing.

const MODELS = {
  // ── Anthropic (Claude) ──
  "claude-opus-4-8":   { provider: "anthropic", inputPer1M: 5.0,  outputPer1M: 25.0, tier: "premium" },
  "claude-sonnet-4-6": { provider: "anthropic", inputPer1M: 3.0,  outputPer1M: 15.0, tier: "mid" },
  "claude-haiku-4-5":  { provider: "anthropic", inputPer1M: 1.0,  outputPer1M: 5.0,  tier: "light" },

  // ── OpenAI ──
  "gpt-4o":            { provider: "openai", inputPer1M: 2.5,  outputPer1M: 10.0, tier: "premium" },
  "gpt-4o-mini":       { provider: "openai", inputPer1M: 0.15, outputPer1M: 0.6,  tier: "light" },

  // ── Google Gemini ──
  "gemini-2.5-pro":        { provider: "gemini", inputPer1M: 1.25, outputPer1M: 10.0, tier: "premium" },
  "gemini-2.5-flash":      { provider: "gemini", inputPer1M: 0.3,  outputPer1M: 2.5,  tier: "light" },
  "gemini-2.5-flash-lite": { provider: "gemini", inputPer1M: 0.1,  outputPer1M: 0.4,  tier: "light" },

  // ── Amazon Bedrock (Nova + Claude + Llama) ──
  "us.amazon.nova-pro-v1:0":                   { provider: "bedrock-nova", inputPer1M: 0.8,   outputPer1M: 3.2,  tier: "mid" },
  "us.amazon.nova-lite-v1:0":                  { provider: "bedrock-nova", inputPer1M: 0.06,  outputPer1M: 0.24, tier: "light" },
  "us.amazon.nova-micro-v1:0":                 { provider: "bedrock-nova", inputPer1M: 0.035, outputPer1M: 0.14, tier: "light" },
  "anthropic.claude-3-5-sonnet-20241022-v2:0": { provider: "bedrock-nova", inputPer1M: 3.0,   outputPer1M: 15.0, tier: "premium" },
  "meta.llama3-70b-instruct-v1:0":             { provider: "bedrock-nova", inputPer1M: 0.99,  outputPer1M: 0.99, tier: "mid" },
  "meta.llama3-8b-instruct-v1:0":              { provider: "bedrock-nova", inputPer1M: 0.22,  outputPer1M: 0.22, tier: "light" },

  // ── DeepSeek ──
  "deepseek-chat":     { provider: "deepseek", inputPer1M: 0.27, outputPer1M: 1.10, tier: "light" },
  "deepseek-reasoner": { provider: "deepseek", inputPer1M: 0.55, outputPer1M: 2.19, tier: "premium" },

  // ── Moonshot AI (Kimi) ──
  "moonshot-v1-8k":   { provider: "moonshot", inputPer1M: 0.12, outputPer1M: 0.12, tier: "light" },
  "moonshot-v1-32k":  { provider: "moonshot", inputPer1M: 0.24, outputPer1M: 0.24, tier: "mid" },
  "moonshot-v1-128k": { provider: "moonshot", inputPer1M: 0.82, outputPer1M: 0.82, tier: "premium" },

  // ── xAI (Grok) ──
  "grok-3":      { provider: "xai", inputPer1M: 3.0,  outputPer1M: 15.0, tier: "premium" },
  "grok-3-mini": { provider: "xai", inputPer1M: 0.30, outputPer1M: 0.50, tier: "light" },

  // ── Groq (fast inference) ──
  "llama-3.3-70b-versatile": { provider: "groq", inputPer1M: 0.59, outputPer1M: 0.79, tier: "mid" },
  "llama-3.1-8b-instant":    { provider: "groq", inputPer1M: 0.05, outputPer1M: 0.08, tier: "light" },
};

// Suggested light-tier downgrade target per provider (used by the recommender).
const LIGHT_TARGET_BY_PROVIDER = {
  anthropic: "claude-haiku-4-5",
  openai: "gpt-4o-mini",
  gemini: "gemini-2.5-flash-lite",
  "bedrock-nova": "us.amazon.nova-lite-v1:0",
  deepseek: "deepseek-chat",
  moonshot: "moonshot-v1-8k",
  xai: "grok-3-mini",
  groq: "llama-3.1-8b-instant",
};

// Task types that are "cheap work" — safe candidates for a lighter model.
// Matches the scope's task taxonomy.
const CHEAP_TASK_TYPES = new Set([
  "classification",
  "extraction",
  "summarisation",
  "translation",
  "faq",
  "support response",
]);

function getModel(modelId) {
  return MODELS[modelId] || null;
}

function isPremium(modelId) {
  const m = MODELS[modelId];
  return !!m && m.tier === "premium";
}

function isCheapTask(taskType) {
  return CHEAP_TASK_TYPES.has(String(taskType || "").toLowerCase());
}

// Cost in USD for a single call given token usage. Unknown model → zeros.
function costFor(modelId, promptTokens = 0, completionTokens = 0) {
  const m = MODELS[modelId];
  if (!m) return { inputCost: 0, outputCost: 0, totalCost: 0 };
  const inputCost = (Number(promptTokens) / 1e6) * m.inputPer1M;
  const outputCost = (Number(completionTokens) / 1e6) * m.outputPer1M;
  return {
    inputCost,
    outputCost,
    totalCost: inputCost + outputCost,
  };
}

// Suggested cheaper target for a premium model on a cheap task.
function suggestLightTarget(modelId) {
  const m = MODELS[modelId];
  if (!m) return null;
  const target = LIGHT_TARGET_BY_PROVIDER[m.provider];
  if (!target || target === modelId) return null;
  return { provider: m.provider, model: target };
}

module.exports = {
  MODELS,
  CHEAP_TASK_TYPES,
  LIGHT_TARGET_BY_PROVIDER,
  getModel,
  isPremium,
  isCheapTask,
  costFor,
  suggestLightTarget,
};
