// DB-backed model registry — drop-in replacement for pricing/table.js.
// All getters are SYNCHRONOUS (reads from in-memory cache) so existing callers
// need no async changes. Cache is populated at boot via init() and refreshed
// after any write via reload().

const ModelEntry = require("../models/ModelEntry");
const Settings = require("../models/Settings");
const { run: seedModels, SEED_VERSION } = require("../seed/seedModels");

// Task types that are "cheap work" — safe candidates for a lighter model.
const CHEAP_TASK_TYPES = new Set([
  "classification",
  "extraction",
  "summarisation",
  "translation",
  "faq",
  "support response",
]);

// Suggested light-tier downgrade target per provider (used by the recommender).
// This mirrors the shipping defaults; users can override per-provider via
// Settings → routing policy in the dashboard.
const LIGHT_TARGET_BY_PROVIDER = {
  anthropic:      "claude-haiku-4-5",
  openai:         "gpt-4o-mini",
  gemini:         "gemini-2.5-flash-lite",
  "bedrock-nova": "us.amazon.nova-lite-v1:0",
  deepseek:       "deepseek-chat",
  moonshot:       "moonshot-v1-8k",
  xai:            "grok-3-mini",
  groq:           "llama-3.1-8b-instant",
};

// In-memory cache: { [id]: { id, provider, label, inputPer1M, outputPer1M, tier } }
let _cache = {};
let _ready = false;

async function _load() {
  const docs = await ModelEntry.find({ enabled: true }).lean();
  _cache = Object.fromEntries(docs.map((d) => [d.id, d]));
  _ready = true;
}

// Called once at server boot after mongoose.connect().
// Re-seeds when SEED_VERSION has changed (or collection is empty), then warms the cache.
async function init() {
  const s     = await Settings.get();
  const count = await ModelEntry.countDocuments();
  if (count === 0 || s.modelSeedVersion !== SEED_VERSION) {
    await seedModels(ModelEntry);
    await Settings.findOneAndUpdate(
      { key: "global" },
      { $set: { modelSeedVersion: SEED_VERSION } },
      { upsert: true }
    );
    console.log(`[registry] models seeded to version ${SEED_VERSION}`);
  }
  await _load();
  console.log(`[registry] ${Object.keys(_cache).length} models loaded`);
}

// Call after any write to /api/models to keep cache current.
async function reload() {
  await _load();
}

// ── Sync accessors (safe after init()) ──────────────────────────────────────

function getModel(id) {
  return _cache[id] || null;
}

function listModels() {
  return Object.values(_cache);
}

function isPremium(id) {
  const m = _cache[id];
  return !!m && m.tier === "premium";
}

function isCheapTask(taskType) {
  return CHEAP_TASK_TYPES.has(String(taskType || "").toLowerCase());
}

// promptTokens is TOTAL input (including any cached tokens). `cache` optionally splits out
// cached-read and cache-write tokens so they bill at the provider's cache rates. Omitting cache
// (or a model with no cache rates) prices everything at inputPer1M — identical to before.
function costFor(modelId, promptTokens = 0, completionTokens = 0, cache = {}) {
  const m = _cache[modelId];
  if (!m) return { inputCost: 0, outputCost: 0, totalCost: 0 };
  const cachedRead = Number(cache.cachedReadTokens) || 0;
  const cacheWrite = Number(cache.cacheWriteTokens) || 0;
  const uncached   = Math.max(0, Number(promptTokens) - cachedRead - cacheWrite);
  const readRate   = m.cacheReadPer1M  != null ? m.cacheReadPer1M  : m.inputPer1M;
  const writeRate  = m.cacheWritePer1M != null ? m.cacheWritePer1M : m.inputPer1M;
  const inputCost  = (uncached / 1e6) * m.inputPer1M
                   + (cachedRead / 1e6) * readRate
                   + (cacheWrite / 1e6) * writeRate;
  const outputCost = (Number(completionTokens) / 1e6) * m.outputPer1M;
  return { inputCost, outputCost, totalCost: inputCost + outputCost };
}

function suggestLightTarget(modelId) {
  const m = _cache[modelId];
  if (!m) return null;
  const target = LIGHT_TARGET_BY_PROVIDER[m.provider];
  if (!target || target === modelId) return null;
  return { provider: m.provider, model: target };
}

module.exports = {
  // Constants (same shape as table.js — used by policy.js)
  CHEAP_TASK_TYPES,
  LIGHT_TARGET_BY_PROVIDER,
  // Lifecycle
  init,
  reload,
  // Sync accessors
  getModel,
  listModels,
  isPremium,
  isCheapTask,
  costFor,
  suggestLightTarget,
};
