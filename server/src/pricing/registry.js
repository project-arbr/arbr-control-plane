// DB-backed model registry — drop-in replacement for pricing/table.js.
// All getters are SYNCHRONOUS (reads from in-memory cache) so existing callers
// need no async changes. Cache is populated at boot via init() and refreshed
// after any write via reload().

const ModelEntry = require("../models/ModelEntry");
const Settings = require("../models/Settings");
const { clampMaxTokens } = require("./clamp");
const { perConnCache } = require("../db/context");

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
  mistral:        "mistral-small-latest",
};

// In-memory cache of { [id]: modelDoc } — PER CONNECTION (per tenant DB), not a process-global.
// Under database-per-tenant hosting a single global object would serve one tenant's models to all
// tenants (and go empty after a restart until a write repopulated it); perConnCache keys each slot by
// the connection's db name. In OSS there is one connection, so it behaves like a single cache.
const _cache = perConnCache();
const TTL_MS = Number(process.env.ARBR_REGISTRY_TTL_MS) || 5 * 60 * 1000;

function _models() {
  const slot = _cache.get();
  return (slot && slot.models) || {};
}

async function _load() {
  const docs = await ModelEntry.find({ enabled: true }).lean();
  _cache.set({ models: Object.fromEntries(docs.map((d) => [d.id, d])), at: Date.now() });
}

// Populate the CURRENT connection's slot when empty or past the TTL. Called once per request by the
// tenancy middleware (inside the tenant connection), so the synchronous accessors below have this
// tenant's models. Cheap after the first load per tenant per TTL.
async function ensureLoaded() {
  const slot = _cache.get();
  if (slot && Date.now() - slot.at < TTL_MS) return;
  await _load();
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
  console.log(`[registry] ${Object.keys(_models()).length} models loaded`);
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
  return _models()[id] || null;
}

function listModels() {
  return Object.values(_models());
}

// Vision-capable model IDs, optionally restricted to live providers. Used to tell
// a caller which models can actually take an image when routing landed on one that
// cannot. Only affirmatively-flagged models qualify (null = unknown = excluded).
function listVisionModels(liveIds = null) {
  const live = liveIds ? new Set(liveIds) : null;
  return Object.values(_models())
    .filter((m) => m.supportsVision === true && (!live || live.has(m.provider)))
    .map((m) => m.id)
    .sort();
}

// Suggest registry IDs close to an unresolved one, for a "did you mean" hint.
// The common miss is a client sending a bare ID for a model the registry stores
// region-scoped, e.g. "deepseek.v3.2" when the ID is "ap-southeast-3/deepseek.v3.2".
function suggestModels(query, opts = {}) {
  return rankSuggestions(query, Object.values(_models()), opts);
}

// Pure ranker over an explicit model list, so the scoring is testable without a DB.
// Ranking: exact tail after a "/" or "." first (the region-prefix case), then
// substring either way. `liveIds` (optional) floats connected providers up, since
// a suggestion the caller cannot actually reach is not much of a suggestion.
function rankSuggestions(query, models, { limit = 5, liveIds = null } = {}) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return [];
  const live = liveIds ? new Set(liveIds) : null;
  const scored = [];
  for (const m of models || []) {
    const id = m.id;
    const lid = id.toLowerCase();
    let score = 0;
    if (lid === q) score = 100;
    else if (lid.endsWith("/" + q) || lid.endsWith("." + q)) score = 80; // region/prefix variant
    else if (lid.includes(q)) score = 50;
    else if (q.includes(lid)) score = 30;
    if (!score) continue;
    if (live && live.has(m.provider)) score += 10; // reachable beats unreachable
    scored.push({ id, score });
  }
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return scored.slice(0, limit).map((s) => s.id);
}

function isPremium(id) {
  const m = _models()[id];
  return !!m && m.tier === "premium";
}

function isCheapTask(taskType) {
  return CHEAP_TASK_TYPES.has(String(taskType || "").toLowerCase());
}

// promptTokens is TOTAL input (including any cached tokens). `cache` optionally splits out
// cached-read and cache-write tokens so they bill at the provider's cache rates. Omitting cache
// (or a model with no cache rates) prices everything at inputPer1M — identical to before.
function costFor(modelId, promptTokens = 0, completionTokens = 0, cache = {}) {
  const m = _models()[modelId];
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
  const m = _models()[modelId];
  return m && m.maxOutputTokens ? m.maxOutputTokens : null;
}

function suggestLightTarget(modelId) {
  const m = _models()[modelId];
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
  ensureLoaded,
  reload,
  startAutoRefresh,
  stopAutoRefresh,
  // Sync accessors
  getModel,
  listModels,
  listVisionModels,
  suggestModels,
  rankSuggestions, // pure, exported for tests
  isPremium,
  isCheapTask,
  costFor,
  maxOutputFor,
  clampMaxTokens,
  suggestLightTarget,
};
