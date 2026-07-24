// DB-backed model registry — drop-in replacement for pricing/table.js.
// All getters are SYNCHRONOUS (reads from in-memory cache) so existing callers
// need no async changes. Cache is populated at boot via init() and refreshed
// after any write via reload().

const ModelEntry = require("../models/ModelEntry");
const Settings = require("../models/Settings");
const { clampMaxTokens } = require("./clamp");

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
// LiteLLM sync is the single source of truth — no static seed.
// On a fresh install (empty DB) we auto-sync so the registry isn't empty on first boot.
// On existing installs we convert any legacy builtIn=true models to builtIn=false so
// the sync cleanup step can manage them going forward.
async function init() {
  const count = await ModelEntry.countDocuments();
  if (count === 0) {
    console.log("[registry] no models found — running initial LiteLLM sync…");
    await require("../litellm/sync").run().catch((e) =>
      console.warn("[registry] initial sync failed (run Sync Models in the UI):", e.message)
    );
  } else {
    // Unmark legacy seed models so sync cleanup can manage them going forward.
    await ModelEntry.updateMany({ builtIn: true }, { $set: { builtIn: false } });
  }
  await _load();
  console.log(`[registry] ${Object.keys(_cache).length} models loaded`);
  startAutoRefresh();
}

// reload() only refreshes the process that served the write. On a multi-replica
// deploy every other replica kept a cache from boot forever, so a model imported
// or enabled elsewhere stayed invisible to getModel() until restart — which then
// silently downgraded anything resolved through it, like the default model. The
// accessors are synchronous (hot path), so the refresh runs on a timer instead.
const REFRESH_MS = Number(process.env.ARBR_REGISTRY_REFRESH_MS) || 60_000;
let _timer = null;
function startAutoRefresh(ms = REFRESH_MS) {
  if (_timer || !(ms > 0)) return;
  _timer = setInterval(() => {
    _load().catch((e) => console.warn("[registry] background refresh failed:", e.message));
  }, ms);
  if (_timer.unref) _timer.unref();
}
function stopAutoRefresh() {
  if (_timer) { clearInterval(_timer); _timer = null; }
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

// Max completion tokens the model accepts, or null when unknown. The gateway uses this
// to clamp an over-large client max_tokens to the served model's ceiling.
function maxOutputFor(modelId) {
  const m = _cache[modelId];
  return m && m.maxOutputTokens ? m.maxOutputTokens : null;
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
  startAutoRefresh,
  stopAutoRefresh,
  // Sync accessors
  getModel,
  listModels,
  isPremium,
  isCheapTask,
  costFor,
  maxOutputFor,
  clampMaxTokens,
  suggestLightTarget,
};
