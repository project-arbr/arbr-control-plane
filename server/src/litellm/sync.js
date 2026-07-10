// LiteLLM sync — two jobs in one pass:
//
//  1. DISCOVER: import ALL chat models from LiteLLM catalog that don't yet
//     exist in the Arbr registry. No provider whitelist — everything in the
//     JSON is eligible.
//
//  2. REFRESH: update pricing, context window, and all capability flags on
//     every existing model, whether built-in or discovered.
//
// Source: https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json
// No auth required. ~3k models, updated weekly.
//
// NEVER touches: tier, label, builtIn, enabled — Arbr owns those once set.

const ModelEntry = require("../models/ModelEntry");
const Settings   = require("../models/Settings");
const { isChatLikelyModelId } = require("../providers/importLogic");

const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

const GITHUB_COMMITS_URL =
  "https://api.github.com/repos/BerriAI/litellm/commits?path=model_prices_and_context_window.json&per_page=1";

// ── Provider name normalisation ───────────────────────────────────────────────
//
// LiteLLM key prefixes → Arbr provider IDs.
// Rules: underscores become hyphens; a handful of special cases where LiteLLM
// uses a name that differs from Arbr's gateway routing ID.
//
// This is NOT a whitelist — unlisted prefixes are still imported; they just get
// the generic underscore→hyphen transformation.

const PROVIDER_REMAP = {
  bedrock:                     "bedrock-nova",  // Arbr gateway uses bedrock-nova
  bedrock_converse:            "bedrock-nova",
  cohere_chat:                 "cohere",
  "vertex_ai-language-models": "vertex-ai",
  vertex_ai:                   "vertex-ai",
  together_ai:                 "together-ai",
  fireworks_ai:                "fireworks",
  lambda_ai:                   "lambda-ai",
  azure_ai:                    "azure-ai",
};

function normalizeProvider(prefix) {
  return PROVIDER_REMAP[prefix] ?? prefix.replace(/_/g, "-");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Per-token cost (USD) → per-1M rate, or null when absent/non-positive.
function per1M(costPerToken) {
  const c = parseFloat(costPerToken);
  return isFinite(c) && c > 0 ? +(c * 1_000_000).toFixed(4) : null;
}

function deriveTier(inputPer1M, outputPer1M) {
  const avg = (inputPer1M + outputPer1M) / 2;
  if (avg >= 8)   return "premium";
  if (avg >= 0.8) return "mid";
  return "light";
}

function toLabel(modelId) {
  const cleaned = modelId
    .replace(/:0+$/, "")
    .replace(/^us\.(amazon|anthropic|meta|mistral|cohere)\./i, "")
    .replace(/\./g, "-");
  return cleaned
    .split(/[-/]/)
    .filter(Boolean)
    .map((w) => {
      if (/^\d/.test(w)) return w;
      if (w.length <= 3) return w.toUpperCase();
      return w[0].toUpperCase() + w.slice(1);
    })
    .join(" ");
}

function extractFlags(entry) {
  const flag = (key) => (entry[key] != null ? !!entry[key] : null);
  return {
    supportsVision:          flag("supports_vision"),
    supportsReasoning:       flag("supports_reasoning"),
    supportsFunctionCalling: flag("supports_function_calling"),
    supportsPdfInput:        flag("supports_pdf_input"),
    supportsPromptCaching:   flag("supports_prompt_caching"),
    supportsResponseSchema:  flag("supports_response_schema"),
    supportsVideoInput:      flag("supports_video_input"),
  };
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

// ── Build index from LiteLLM JSON ─────────────────────────────────────────────
//
// Returns { byKey: Map<"provider:id" → entry>, byProvider: Map<provider → Set<id>> }
// Only includes entries with mode=chat.
//
// LiteLLM historically used an "openai/model-id" prefix for OpenAI models, but
// switched to bare names (e.g. "gpt-4.1", "o3") without prefixes. We detect
// those by matching well-known OpenAI model id prefixes and map them to
// provider "openai". All other bare-name entries are skipped.

const OPENAI_BARE_RE = /^(gpt-|chatgpt-|o\d)/;

function buildIndex(data) {
  const byKey      = new Map();   // "provider:id" → ltEntry
  const byProvider = new Map();   // provider → Set<id>

  for (const [ltKey, ltEntry] of Object.entries(data)) {
    if (ltEntry.mode !== "chat") continue;

    const slashIdx = ltKey.indexOf("/");
    let prefix, id;

    if (slashIdx === -1) {
      // Bare-name: only import known OpenAI ids; skip fine-tunes (ft:)
      if (!OPENAI_BARE_RE.test(ltKey) || ltKey.startsWith("ft:")) continue;
      prefix = "openai";
      id     = ltKey;
    } else {
      prefix = ltKey.slice(0, slashIdx);
      id     = ltKey.slice(slashIdx + 1);
    }

    const provider = normalizeProvider(prefix);

    // Skip deprecated
    if (ltEntry.deprecated === true) continue;
    // Skip dated snapshots: -YYYY-MM-DD, -YYYYMMDD, -YYYY-MM
    if (/-\d{4}-\d{2}-\d{2}$|-\d{8}$|-20\d{2}-\d{2}$/.test(id)) continue;

    const key = `${provider}:${id}`;
    if (!byKey.has(key)) {
      byKey.set(key, ltEntry);
      if (!byProvider.has(provider)) byProvider.set(provider, new Set());
      byProvider.get(provider).add(id);
    }
  }

  return { byKey, byProvider };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  const [version, ltRes] = await Promise.all([
    fetchVersion(),
    fetch(LITELLM_URL, { headers: { "User-Agent": "arbr-control-plane" } }),
  ]);

  if (!ltRes.ok) throw new Error(`LiteLLM JSON fetch failed: ${ltRes.status}`);
  const data = await ltRes.json();
  const now  = new Date();

  const { byKey, byProvider } = buildIndex(data);

  // ── 1. DISCOVER: insert models that don't exist yet ───────────────────────
  const existingDocs = await ModelEntry.find({}, { id: 1, provider: 1 }).lean();
  const existingKeys = new Set(existingDocs.map((m) => `${m.provider}:${m.id}`));

  const toInsert = [];
  const addedByProvider = {};

  for (const [compositeKey, ltEntry] of byKey) {
    if (existingKeys.has(compositeKey)) continue;

    const colonIdx  = compositeKey.indexOf(":");
    const provider  = compositeKey.slice(0, colonIdx);
    const id        = compositeKey.slice(colonIdx + 1);

    const inputCost   = parseFloat(ltEntry.input_cost_per_token);
    const outputCost  = parseFloat(ltEntry.output_cost_per_token);
    const inputPer1M  = isFinite(inputCost)  && inputCost  > 0 ? +(inputCost  * 1_000_000).toFixed(4) : 0;
    const outputPer1M = isFinite(outputCost) && outputCost > 0 ? +(outputCost * 1_000_000).toFixed(4) : 0;

    toInsert.push({
      id,
      provider,
      label:         toLabel(id),
      inputPer1M,
      outputPer1M,
      cacheReadPer1M:  per1M(ltEntry.cache_read_input_token_cost),
      cacheWritePer1M: per1M(ltEntry.cache_creation_input_token_cost),
      tier:          deriveTier(inputPer1M, outputPer1M),
      builtIn:       false,
      enabled:       true,
      contextWindow: parseInt(ltEntry.max_input_tokens, 10) || null,
      maxOutputTokens: parseInt(ltEntry.max_output_tokens, 10) || null,
      litellmSyncedAt: now,
      ...extractFlags(ltEntry),
    });

    existingKeys.add(compositeKey);
    addedByProvider[provider] = (addedByProvider[provider] || 0) + 1;
  }

  let added = 0;
  if (toInsert.length > 0) {
    await ModelEntry.insertMany(toInsert, { ordered: false }).catch(() => {});
    added = toInsert.length;
    console.log(`[litellm] discovered ${added} new models across ${Object.keys(addedByProvider).length} providers`);
  }

  // ── 2. CLEANUP: remove stale non-builtIn models ───────────────────────────
  const toDelete = [];
  for (const [provider, validIds] of byProvider) {
    const stored = await ModelEntry.find({ provider, builtIn: false }, { id: 1 }).lean();
    for (const m of stored) {
      if (!validIds.has(m.id)) toDelete.push({ provider, id: m.id });
    }
  }
  if (toDelete.length > 0) {
    const ids = toDelete.map((d) => d.id);
    await ModelEntry.deleteMany({ id: { $in: ids }, builtIn: false });
    console.log(`[litellm] removed ${toDelete.length} stale models`);
  }

  // ── 3. REFRESH: update pricing + flags on all models ─────────────────────
  const allModels = await ModelEntry.find({}).lean();
  let matched = 0;
  const skipped = [];

  for (const model of allModels) {
    // Mark routability from the id heuristic for EVERY model — including ones absent from the
    // LiteLLM catalog (e.g. Gemini's `lyria-*` music model) that the pricing refresh below skips.
    // This is what demotes media/embedding models so they're excluded from automated routing.
    const chatCapable = isChatLikelyModelId(model.id);

    const ltEntry = byKey.get(`${model.provider}:${model.id}`);
    if (!ltEntry) {
      skipped.push(`${model.provider}:${model.id}`);
      if (model.chatCapable !== chatCapable) {
        await ModelEntry.updateOne({ id: model.id, provider: model.provider }, { $set: { chatCapable } });
      }
      continue;
    }

    const update = { litellmSyncedAt: now, chatCapable };

    const inputCost  = parseFloat(ltEntry.input_cost_per_token);
    const outputCost = parseFloat(ltEntry.output_cost_per_token);
    if (isFinite(inputCost)  && inputCost  > 0) update.inputPer1M  = +(inputCost  * 1_000_000).toFixed(4);
    if (isFinite(outputCost) && outputCost > 0) update.outputPer1M = +(outputCost * 1_000_000).toFixed(4);
    const cacheRead  = per1M(ltEntry.cache_read_input_token_cost);
    const cacheWrite = per1M(ltEntry.cache_creation_input_token_cost);
    if (cacheRead  !== null) update.cacheReadPer1M  = cacheRead;
    if (cacheWrite !== null) update.cacheWritePer1M = cacheWrite;

    const maxIn = parseInt(ltEntry.max_input_tokens, 10);
    if (isFinite(maxIn) && maxIn > 0) update.contextWindow = maxIn;
    const maxOut = parseInt(ltEntry.max_output_tokens, 10);
    if (isFinite(maxOut) && maxOut > 0) update.maxOutputTokens = maxOut;

    const flags = extractFlags(ltEntry);
    for (const [k, v] of Object.entries(flags)) {
      if (v !== null) update[k] = v;
    }

    await ModelEntry.updateOne({ id: model.id, provider: model.provider }, { $set: update });
    matched++;
  }

  await Settings.findOneAndUpdate(
    { key: "global" },
    { $set: { litellmSyncedAt: now, litellmVersion: version || "unknown" } },
    { upsert: true }
  );

  console.log(`[litellm] refreshed ${matched}/${allModels.length} models (${added} new, ${skipped.length} unmatched)`);
  return {
    matched,
    added,
    removed: toDelete.length,
    total:   allModels.length,
    version,
    providers: addedByProvider,
  };
}

module.exports = { run };
