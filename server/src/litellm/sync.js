// LiteLLM sync — two jobs in one pass:
//
//  1. DISCOVER: for each connected provider, upsert any chat models from the
//     LiteLLM catalog that don't exist yet in the Arbr model registry. This
//     expands the library automatically whenever a new provider is connected.
//
//  2. REFRESH: update inputPer1M, outputPer1M, contextWindow, supportsVision,
//     supportsReasoning on ALL existing models (old and newly discovered).
//
// Source: https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json
// No auth required. ~3k models, updated weekly.
//
// NEVER touches: tier, label, builtIn, enabled — Arbr owns those once set.

const ModelEntry  = require("../models/ModelEntry");
const Settings    = require("../models/Settings");
const connections = require("../providers/connections");

const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

const GITHUB_COMMITS_URL =
  "https://api.github.com/repos/BerriAI/litellm/commits?path=model_prices_and_context_window.json&per_page=1";

// ── Provider → LiteLLM key mapping ────────────────────────────────────────────
//
// match(ltKey)  — returns true if this LiteLLM key belongs to this provider
// id(ltKey)     — the model ID to store in Arbr (often strips the prefix)
//
// Conventions used in Arbr seeds:
//   openai      → bare name  (gpt-4o, o3-mini)
//   anthropic   → bare name  (claude-opus-4-8)
//   gemini      → bare name  (gemini-2.5-pro)   [LiteLLM key: gemini/gemini-2.5-pro]
//   bedrock-nova→ us.* cross-region name         [LiteLLM key: bedrock/us.amazon.nova-micro-v1:0]
//   deepseek    → bare name  (deepseek-chat)     [LiteLLM key: deepseek/deepseek-chat]
//   xai         → bare name  (grok-3)            [LiteLLM key: xai/grok-3]
//   groq        → bare name  (llama-3.3-70b-versatile) [LiteLLM key: groq/llama-3.3-70b-versatile]
//   moonshot    → bare name  (moonshot-v1-8k)    [LiteLLM key: moonshot/moonshot-v1-8k]

const PROVIDER_IMPORT = {
  openai: {
    match: (k) => !k.includes("/") && /^(gpt-|o\d|chatgpt-)/.test(k),
    id:    (k) => k,
    provider: "openai",
  },
  anthropic: {
    match: (k) => !k.includes("/") && k.startsWith("claude-"),
    id:    (k) => k,
    provider: "anthropic",
  },
  gemini: {
    // Only import models whose name starts with "gemini-" — excludes lyria-*, learnlm-*, gemma-*
    // (LiteLLM incorrectly marks some non-chat Google models as mode:chat)
    match: (k) => k.startsWith("gemini/gemini-"),
    id:    (k) => k.slice("gemini/".length),
    provider: "gemini",
  },
  "bedrock-nova": {
    // Only import cross-region inference profiles (us.*) — same format as seed
    match: (k) => k.startsWith("bedrock/us."),
    id:    (k) => k.slice("bedrock/".length),
    provider: "bedrock-nova",
  },
  deepseek: {
    match: (k) => k.startsWith("deepseek/"),
    id:    (k) => k.slice("deepseek/".length),
    provider: "deepseek",
  },
  xai: {
    match: (k) => k.startsWith("xai/"),
    id:    (k) => k.slice("xai/".length),
    provider: "xai",
  },
  groq: {
    // Exclude nested paths like groq/openai/gpt-oss-120b (double slash = not a real Groq model ID)
    match: (k) => k.startsWith("groq/") && !k.slice(5).includes("/"),
    id:    (k) => k.slice("groq/".length),
    provider: "groq",
  },
  moonshot: {
    match: (k) => k.startsWith("moonshot/"),
    id:    (k) => k.slice("moonshot/".length),
    provider: "moonshot",
  },
};

// Provider prefixes tried when matching existing Arbr model IDs to LiteLLM keys
const PROVIDER_PREFIXES = [
  "",           // bare name (gpt-4o, claude-opus-4-8, grok-3)
  "gemini/",    // gemini/gemini-2.5-pro
  "bedrock/",   // bedrock/us.amazon.nova-micro-v1:0
  "groq/",      // groq/llama-3.3-70b-versatile
  "xai/",       // xai/grok-3
  "deepseek/",  // deepseek/deepseek-chat
  "moonshot/",  // moonshot/moonshot-v1-8k
  "vertex_ai/",
  "anthropic/",
  "openai/",
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function deriveTier(inputPer1M, outputPer1M) {
  const avg = (inputPer1M + outputPer1M) / 2;
  if (avg >= 8)   return "premium";
  if (avg >= 0.8) return "mid";
  return "light";
}

function toLabel(modelId) {
  const cleaned = modelId
    .replace(/:0+$/, "")                                            // bedrock :0 suffix
    .replace(/^us\.(amazon|anthropic|meta|mistral|cohere)\./i, "") // bedrock cross-region prefix
    .replace(/\./g, "-");                                           // dots to dashes

  return cleaned
    .split("-")
    .filter(Boolean)
    .map((w) => {
      if (/^\d/.test(w)) return w;
      if (w.length <= 3) return w.toUpperCase();
      return w[0].toUpperCase() + w.slice(1);
    })
    .join(" ");
}

async function fetchVersion() {
  try {
    const res = await fetch(GITHUB_COMMITS_URL, {
      headers: { Accept: "application/vnd.github.v3+json", "User-Agent": "arbr-control-plane" },
    });
    if (!res.ok) return null;
    const commits = await res.json();
    return commits[0]?.sha?.slice(0, 8) || null;
  } catch {
    return null;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  const [version, ltRes, eff] = await Promise.all([
    fetchVersion(),
    fetch(LITELLM_URL, { headers: { "User-Agent": "arbr-control-plane" } }),
    connections.effective(),
  ]);

  if (!ltRes.ok) throw new Error(`LiteLLM JSON fetch failed: ${ltRes.status}`);
  const data    = await ltRes.json();
  const liveIds = eff.liveIds || [];
  const now     = new Date();

  // ── 1. Discover new models for connected providers ─────────────────────────
  let added = 0;
  const existingIds = new Set(
    (await ModelEntry.find({}, { id: 1 }).lean()).map((m) => m.id)
  );

  const toInsert = [];

  for (const [arbrProvider, rule] of Object.entries(PROVIDER_IMPORT)) {
    if (!liveIds.includes(arbrProvider)) continue;

    for (const [ltKey, ltEntry] of Object.entries(data)) {
      if (ltEntry.mode !== "chat") continue;
      if (!rule.match(ltKey)) continue;

      const modelId = rule.id(ltKey);
      if (existingIds.has(modelId)) continue;

      const inputCost  = parseFloat(ltEntry.input_cost_per_token);
      const outputCost = parseFloat(ltEntry.output_cost_per_token);
      const inputPer1M  = isFinite(inputCost)  && inputCost  > 0 ? +(inputCost  * 1_000_000).toFixed(4) : 0;
      const outputPer1M = isFinite(outputCost) && outputCost > 0 ? +(outputCost * 1_000_000).toFixed(4) : 0;

      toInsert.push({
        id:               modelId,
        provider:         rule.provider,
        label:            toLabel(modelId),
        inputPer1M,
        outputPer1M,
        tier:             deriveTier(inputPer1M, outputPer1M),
        builtIn:          false,
        enabled:          true,
        contextWindow:    parseInt(ltEntry.max_input_tokens, 10) || null,
        supportsVision:   ltEntry.supports_vision    != null ? !!ltEntry.supports_vision    : null,
        supportsReasoning:ltEntry.supports_reasoning != null ? !!ltEntry.supports_reasoning : null,
        litellmSyncedAt:  now,
      });

      existingIds.add(modelId); // prevent duplicates within this run
    }
  }

  if (toInsert.length > 0) {
    await ModelEntry.insertMany(toInsert, { ordered: false }).catch(() => {});
    added = toInsert.length;
    console.log(`[litellm] discovered ${added} new models`);
  }

  // ── 1b. Cleanup: remove non-builtIn models that no longer pass import rules ─
  // Catches models wrongly imported in earlier syncs (bad LiteLLM metadata etc.)
  const validByProvider = {};
  for (const [arbrProvider, rule] of Object.entries(PROVIDER_IMPORT)) {
    if (!liveIds.includes(arbrProvider)) continue;
    const validIds = new Set();
    for (const [ltKey, ltEntry] of Object.entries(data)) {
      if (ltEntry.mode !== "chat") continue;
      if (!rule.match(ltKey)) continue;
      validIds.add(rule.id(ltKey));
    }
    validByProvider[arbrProvider] = validIds;
  }

  const toDelete = [];
  for (const [arbrProvider, validIds] of Object.entries(validByProvider)) {
    const providerModels = await ModelEntry.find({ provider: arbrProvider, builtIn: false }, { id: 1 }).lean();
    for (const m of providerModels) {
      if (!validIds.has(m.id)) toDelete.push(m.id);
    }
  }
  if (toDelete.length > 0) {
    await ModelEntry.deleteMany({ id: { $in: toDelete }, builtIn: false });
    for (const id of toDelete) existingIds.delete(id);
    console.log(`[litellm] removed ${toDelete.length} stale models:`, toDelete);
  }

  // ── 2. Refresh pricing/specs on ALL models (including newly added) ─────────
  const allModels = await ModelEntry.find({}).lean();
  let matched     = 0;
  const skipped   = [];

  for (const model of allModels) {
    let entry = null;
    for (const prefix of PROVIDER_PREFIXES) {
      const key = prefix + model.id;
      if (data[key] && data[key].mode === "chat") { entry = data[key]; break; }
    }

    if (!entry) { skipped.push(model.id); continue; }

    const update = { litellmSyncedAt: now };

    const inputCost  = parseFloat(entry.input_cost_per_token);
    const outputCost = parseFloat(entry.output_cost_per_token);
    if (isFinite(inputCost)  && inputCost  > 0) update.inputPer1M  = +(inputCost  * 1_000_000).toFixed(4);
    if (isFinite(outputCost) && outputCost > 0) update.outputPer1M = +(outputCost * 1_000_000).toFixed(4);

    const maxIn = parseInt(entry.max_input_tokens, 10);
    if (isFinite(maxIn) && maxIn > 0) update.contextWindow = maxIn;

    if (entry.supports_vision    != null) update.supportsVision    = !!entry.supports_vision;
    if (entry.supports_reasoning != null) update.supportsReasoning = !!entry.supports_reasoning;

    await ModelEntry.updateOne({ id: model.id }, { $set: update });
    matched++;
  }

  await Settings.findOneAndUpdate(
    { key: "global" },
    { $set: { litellmSyncedAt: now, litellmVersion: version || "unknown" } },
    { upsert: true }
  );

  console.log(`[litellm] refreshed ${matched}/${allModels.length} models (${added} new, ${skipped.length} unmatched)`);
  return { matched, added, total: allModels.length, version, skipped };
}

module.exports = { run };
