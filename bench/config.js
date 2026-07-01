// Benchmark configuration. Everything price-dependent lives here and is published with results.
// Arbr under test should have its AI policy scoped to exactly this model pool for a fair comparison
// (so "arbr-auto" only ever routes among these), and Require-API-keys on with a key for `application: bench`.
module.exports = {
  gateway: {
    baseURL: process.env.ARBR_BASE_URL || "http://localhost:4100/v1",
    apiKey:  process.env.ARBR_API_KEY  || "none",
  },

  // The model pool the routers choose from, with per-1M-token USD prices (DISCLOSED in results).
  // Cost is computed from these prices + usage — deterministic, not read back from billing.
  pool: {
    premium: "gpt-4o",
    mid:     "us.amazon.nova-pro-v1:0",
    light:   "gpt-4o-mini",
  },
  prices: {
    // model id -> { in, out } USD per 1M tokens
    "gpt-4o":                    { in: 2.50, out: 10.00 },
    "us.amazon.nova-pro-v1:0":   { in: 0.80, out: 3.20 },
    "gpt-4o-mini":               { in: 0.15, out: 0.60 },
    // extend if you widen the pool (e.g. gemini-2.5-flash, deepseek-chat)
  },

  // Routers compared on every benchmark (same prompts, same pool).
  // "routellm" is added in phase 4 (RouteLLM-OSS adapter).
  baselines: ["always-premium", "always-light", "random", "arbr-auto"],

  judgeModel: process.env.ARBR_JUDGE_MODEL || "gpt-4o", // Arena-Hard (phase 2)
  seed: 42,
};
