// AI-generated routing policy: a task-type → model assignment the AI produces from
// the available models (and observed custom task types), editable by an operator and
// regeneratable. Used in auto mode when routingMode === "ai". Cached like the rule set.
const Settings = require("../models/Settings");
const RequestRecord = require("../models/RequestRecord");
const pricing = require("../pricing/registry");
const { TASK_TYPES, TASK_CATALOG } = require("../classify/classifier");
const { projectImpact } = require("./policySim");
const { perConnCache } = require("../db/context");

// Increment when MODEL_CAPABILITIES / TASK_CAPABILITIES / the scoring engine change.
// GET /api/ai-policy auto-regenerates if the stored version is behind.
// HOW TO UPDATE: change the tables/engine below, then increment this number by 1.
// v3: deterministic evidence-based engine (capability gates + traffic-informed expected cost).
// v4: prefix-aware curated-capability matching (Bedrock region/account ids resolve) + DeepSeek V3.x rows.
const CAPABILITY_VERSION = 4;

const _cache = perConnCache(); // per-connection: each tenant caches its own policy map
const TTL_MS = 5000;
function invalidate() { _cache.invalidate(); }

// ── Capability tables ──────────────────────────────────────────────────────────
// Scoring dimensions (order matters for DIMS iteration).
const DIMS = ["coding", "reasoning", "writing", "analysis", "language", "general", "data"];

// Numeric capability scores (0–1) for known models.
// `general` is intentionally high for micro/lite models — they are optimised for
// simple tasks, which is what makes them win over Flash for faq/classification.
const MODEL_CAPABILITIES = {
  // OpenAI — strong reasoning & analysis
  "gpt-4o":                        { coding:0.88, reasoning:0.97, writing:0.90, analysis:0.95, language:0.86, general:0.85, data:0.83 },
  "gpt-4o-mini":                   { coding:0.78, reasoning:0.70, writing:0.80, analysis:0.72, language:0.75, general:0.78, data:0.72 },
  "gpt-4-turbo":                   { coding:0.85, reasoning:0.88, writing:0.85, analysis:0.88, language:0.80, general:0.78, data:0.80 },
  "o1":                            { coding:0.75, reasoning:0.98, writing:0.65, analysis:0.80, language:0.70, general:0.68, data:0.72 },
  "o3-mini":                       { coding:0.82, reasoning:0.95, writing:0.60, analysis:0.72, language:0.65, general:0.65, data:0.70 },
  // Anthropic — strong writing & coding; bedrock IDs included
  "claude-opus-4-8":               { coding:0.90, reasoning:0.95, writing:0.96, analysis:0.95, language:0.85, general:0.84, data:0.85 },
  "claude-sonnet-4-6":             { coding:0.92, reasoning:0.88, writing:0.97, analysis:0.90, language:0.85, general:0.84, data:0.82 },
  "claude-haiku-4-5-20251001":     { coding:0.72, reasoning:0.65, writing:0.72, analysis:0.65, language:0.70, general:0.74, data:0.65 },
  "claude-haiku-4-5":              { coding:0.72, reasoning:0.65, writing:0.72, analysis:0.65, language:0.70, general:0.74, data:0.65 },
  // Bedrock-hosted Anthropic models (same capability profile as their direct equivalents)
  "anthropic.claude-3-5-sonnet-20241022-v2:0": { coding:0.92, reasoning:0.88, writing:0.97, analysis:0.90, language:0.85, general:0.84, data:0.82 },
  "anthropic.claude-3-opus-20240229-v1:0":     { coding:0.88, reasoning:0.92, writing:0.95, analysis:0.92, language:0.83, general:0.82, data:0.82 },
  "anthropic.claude-3-haiku-20240307-v1:0":    { coding:0.72, reasoning:0.65, writing:0.72, analysis:0.65, language:0.70, general:0.74, data:0.65 },
  // Google / Gemini — leading coding & long-context/data
  "gemini-2.5-pro":                { coding:0.97, reasoning:0.88, writing:0.83, analysis:0.88, language:0.92, general:0.80, data:0.95 },
  "gemini-2.5-flash":              { coding:0.85, reasoning:0.70, writing:0.80, analysis:0.72, language:0.85, general:0.72, data:0.72 },
  "gemini-2.5-flash-lite":         { coding:0.65, reasoning:0.50, writing:0.65, analysis:0.55, language:0.75, general:0.72, data:0.55 },
  "gemini-2.0-flash":              { coding:0.80, reasoning:0.65, writing:0.75, analysis:0.68, language:0.82, general:0.72, data:0.68 },
  "gemini-1.5-pro":                { coding:0.80, reasoning:0.85, writing:0.78, analysis:0.85, language:0.82, general:0.78, data:0.78 },
  // AWS Bedrock – Nova
  "us.amazon.nova-pro-v1:0":       { coding:0.72, reasoning:0.80, writing:0.78, analysis:0.82, language:0.65, general:0.72, data:0.70 },
  "us.amazon.nova-lite-v1:0":      { coding:0.55, reasoning:0.55, writing:0.72, analysis:0.58, language:0.62, general:0.75, data:0.52 },
  "us.amazon.nova-micro-v1:0":     { coding:0.42, reasoning:0.40, writing:0.55, analysis:0.45, language:0.62, general:0.80, data:0.40 },
  // Mistral
  "mistral-large-latest":          { coding:0.82, reasoning:0.80, writing:0.80, analysis:0.78, language:0.82, general:0.75, data:0.72 },
  "mistral-medium-latest":         { coding:0.68, reasoning:0.65, writing:0.70, analysis:0.65, language:0.72, general:0.72, data:0.62 },
  "codestral-latest":              { coding:0.95, reasoning:0.55, writing:0.40, analysis:0.50, language:0.45, general:0.55, data:0.62 },
  // DeepSeek
  "deepseek-chat":                 { coding:0.92, reasoning:0.82, writing:0.72, analysis:0.72, language:0.65, general:0.68, data:0.80 },
  "deepseek-reasoner":             { coding:0.78, reasoning:0.97, writing:0.60, analysis:0.75, language:0.60, general:0.62, data:0.70 },
  "deepseek.v3.2":                 { coding:0.90, reasoning:0.88, writing:0.72, analysis:0.76, language:0.66, general:0.72, data:0.80 },
  "deepseek.v3.1":                 { coding:0.90, reasoning:0.84, writing:0.72, analysis:0.74, language:0.66, general:0.70, data:0.80 },
  // xAI
  "grok-2":                        { coding:0.78, reasoning:0.82, writing:0.80, analysis:0.78, language:0.72, general:0.74, data:0.70 },
  "grok-3":                        { coding:0.85, reasoning:0.90, writing:0.85, analysis:0.85, language:0.78, general:0.80, data:0.78 },
  "grok-3-mini":                   { coding:0.72, reasoning:0.78, writing:0.72, analysis:0.72, language:0.68, general:0.72, data:0.65 },
  // Groq / Meta
  "llama-3.3-70b-versatile":       { coding:0.78, reasoning:0.72, writing:0.75, analysis:0.70, language:0.70, general:0.78, data:0.70 },
  "llama-3.1-8b-instant":          { coding:0.55, reasoning:0.50, writing:0.58, analysis:0.50, language:0.60, general:0.72, data:0.50 },
};

// Numeric requirement weights (0–1) per dimension for each known task type.
// High coding weight → a coding-specialist wins.
// High general weight → the cheapest general model wins (cost dominates a small capability gap).
const TASK_CAPABILITIES = {
  // ── Light: general / language ────────────────────────────────────────────────
  "faq":               { coding:0.0, reasoning:0.2, writing:0.3, analysis:0.1, language:0.3, general:0.6, data:0.0 },
  "translation":       { coding:0.0, reasoning:0.1, writing:0.2, analysis:0.0, language:0.9, general:0.2, data:0.0 },
  "summarisation":     { coding:0.0, reasoning:0.3, writing:0.5, analysis:0.5, language:0.2, general:0.3, data:0.0 },
  "classification":    { coding:0.0, reasoning:0.3, writing:0.0, analysis:0.3, language:0.2, general:0.7, data:0.1 },
  // ── Light: coding ────────────────────────────────────────────────────────────
  "code-autocomplete": { coding:0.95, reasoning:0.3,  writing:0.1,  analysis:0.1, language:0.0, general:0.1, data:0.1 },
  "syntax-check":      { coding:0.9,  reasoning:0.2,  writing:0.0,  analysis:0.1, language:0.0, general:0.1, data:0.0 },
  "variable-rename":   { coding:0.7,  reasoning:0.2,  writing:0.3,  analysis:0.1, language:0.1, general:0.2, data:0.0 },
  "comment-generation":{ coding:0.6,  reasoning:0.1,  writing:0.7,  analysis:0.1, language:0.1, general:0.2, data:0.0 },
  "regex-generation":  { coding:0.85, reasoning:0.4,  writing:0.0,  analysis:0.1, language:0.1, general:0.1, data:0.1 },
  "error-explanation": { coding:0.5,  reasoning:0.5,  writing:0.4,  analysis:0.3, language:0.1, general:0.3, data:0.0 },
  // ── Mid: content / extraction ────────────────────────────────────────────────
  "extraction":            { coding:0.2, reasoning:0.4, writing:0.2, analysis:0.7, language:0.2, general:0.3, data:0.5 },
  "content generation":    { coding:0.0, reasoning:0.2, writing:0.95, analysis:0.2, language:0.3, general:0.3, data:0.0 },
  "support response":      { coding:0.0, reasoning:0.3, writing:0.9,  analysis:0.3, language:0.3, general:0.3, data:0.0 },
  // ── Mid: coding / data ───────────────────────────────────────────────────────
  "coding":                { coding:0.95, reasoning:0.5, writing:0.2, analysis:0.2, language:0.0, general:0.1, data:0.3 },
  "unit-test":             { coding:0.9,  reasoning:0.5, writing:0.1, analysis:0.3, language:0.0, general:0.1, data:0.2 },
  "code-review":           { coding:0.8,  reasoning:0.6, writing:0.4, analysis:0.7, language:0.0, general:0.1, data:0.1 },
  "documentation":         { coding:0.5,  reasoning:0.2, writing:0.8, analysis:0.3, language:0.2, general:0.2, data:0.1 },
  "sql-query":             { coding:0.7,  reasoning:0.5, writing:0.0, analysis:0.3, language:0.0, general:0.1, data:0.9 },
  "api-integration":       { coding:0.9,  reasoning:0.4, writing:0.2, analysis:0.2, language:0.0, general:0.1, data:0.4 },
  "data-transformation":   { coding:0.8,  reasoning:0.4, writing:0.0, analysis:0.3, language:0.0, general:0.1, data:0.8 },
  // ── Premium: reasoning/analysis dominant → gpt-4o ────────────────────────────
  "reasoning":               { coding:0.2, reasoning:0.95, writing:0.2, analysis:0.5,  language:0.1, general:0.2, data:0.2 },
  "document analysis":       { coding:0.0, reasoning:0.5,  writing:0.2, analysis:0.95, language:0.3, general:0.2, data:0.3 },
  "architecture-design":     { coding:0.7, reasoning:0.9,  writing:0.3, analysis:0.7,  language:0.0, general:0.1, data:0.4 },
  "security-audit":          { coding:0.8, reasoning:0.8,  writing:0.2, analysis:0.8,  language:0.0, general:0.1, data:0.2 },
  "algorithm-design":        { coding:0.7, reasoning:0.95, writing:0.1, analysis:0.4,  language:0.0, general:0.1, data:0.3 },
  "root-cause-analysis":     { coding:0.4, reasoning:0.85, writing:0.2, analysis:0.9,  language:0.0, general:0.1, data:0.4 },
  // ── Premium: coding/data dominant → gemini-2.5-pro ───────────────────────────
  // Reasoning weight lowered to reflect that these are execution tasks, not pure reasoning.
  "large-refactor":          { coding:0.9, reasoning:0.3,  writing:0.3, analysis:0.6,  language:0.0, general:0.1, data:0.2 },
  "spec-to-code":            { coding:0.9, reasoning:0.4,  writing:0.3, analysis:0.5,  language:0.0, general:0.1, data:0.3 },
  "performance-optimization":{ coding:0.7, reasoning:0.5,  writing:0.1, analysis:0.7,  language:0.0, general:0.1, data:0.7 },
  "migration-planning":      { coding:0.5, reasoning:0.6,  writing:0.3, analysis:0.7,  language:0.0, general:0.1, data:0.8 },
};

// Keywords used in the deriveCapabilities fallback for unknown models.
const DOMAIN_KEYWORDS = {
  coding:    ["coding", "code", "developer", "programming", "function", "instruct"],
  reasoning: ["reasoning", "chain-of-thought", "complex reasoning", "step-by-step", "deduction", "proof", "math"],
  writing:   ["creative", "writing", "generation", "content", "copy", "compose"],
  analysis:  ["analysis", "analytical", "document", "report", "review"],
  language:  ["multilingual", "translation", "chinese", "english", "language"],
  general:   [],
  data:      ["data", "structured", "schema", "query", "database"],
};

// Task types apps have actually sent (lowercased), from the request log.
async function observedTaskTypes() {
  // Customer traffic only — Arbr's own task types must not become routable policy entries.
  const seen = await RequestRecord.distinct("taskType", RequestRecord.CUSTOMER_ONLY);
  return seen.filter(Boolean).map((t) => String(t).toLowerCase());
}

// Built-in catalog ∪ observed (so custom task types get covered).
async function allTaskTypes() {
  const seen = await observedTaskTypes();
  return [...new Set([...TASK_TYPES, ...seen])];
}

// The current assignments map (cached). { [taskType]: modelId }
async function getEffective() {
  const c = _cache.get();
  if (c && Date.now() - c.at < TTL_MS) return c.map;
  const s = await Settings.get();
  const map = (s.aiPolicy && s.aiPolicy.assignments) || {};
  _cache.set({ map, at: Date.now() });
  return map;
}

// Resolve a task type to { provider, model } via the map, or null. Liveness is
// checked by the caller (it has the effective live set).
function lookup(map, taskType) {
  const model = map[String(taskType || "").toLowerCase()];
  if (!model) return null;
  const m = pricing.getModel(model);
  // Serve-time guard: a stale or manually-set assignment pointing at a non-chat model (e.g. a
  // media model like Lyria) must never route. Treat it as unmapped so the caller falls through
  // to the default model instead of 404ing on /chat/completions.
  if (!m || m.chatCapable === false) return null;
  return { provider: m.provider, model };
}

// Resolve the model for a task. By default the policy is authoritative: return exactly the
// model the policy assigns (the caller falls through to the default model if that pick is
// unavailable). Only when `adjust` is enabled (Settings.aiDifficultyAdjust) do we apply the
// per-request difficulty downgrade: if the classifier rated THIS instance easier or harder than
// the task's default tier, re-pick within that tier using the scoring engine. That path can
// substitute a cheaper model NOT in the operator's policy, which is why it is opt-in.
function resolveModel({ map, taskType, difficulty, eff, adjust = false }) {
  const base = lookup(map, taskType);
  // Policy is authoritative unless the operator opted into difficulty adjustment.
  if (!adjust) return base;
  // Only ADJUST an existing policy pick; never invent one for an unmapped task (that stays
  // passthrough, as before). And no difficulty/eff → unchanged behavior.
  if (!base || !difficulty || !eff || !eff.liveIds) return base;
  const tt = String(taskType || "").toLowerCase();
  const catalogTier = TASK_CATALOG.find((t) => t.id === tt)?.tier || null;
  if (difficulty === catalogTier) return base;
  try {
    const liveIdSet = new Set(eff.liveIds);
    const liveModels = pricedPool(pricing.listModels()
      .filter((m) => liveIdSet.has(m.provider) && m.chatCapable !== false))
      .sort((a, b) => (b.inputPer1M || 0) - (a.inputPer1M || 0));
    if (!liveModels.length) return base;
    const catalogMap = Object.fromEntries(TASK_CATALOG.map((t) => [t.id, t]));
    const id = _scoringFallback(tt, liveModels, catalogMap, eff, difficulty);
    const m = pricing.getModel(id);
    if (!m || !liveIdSet.has(m.provider)) return base;

    // Honor the operator's explicit assignment. The difficulty re-pick may stand in
    // for the base ONLY when it is a genuinely CHEAPER real model — a cost downgrade
    // for an easier-than-usual instance. A lateral or pricier pick keeps the explicit
    // choice, so "document analysis" stays on the assigned model instead of being
    // swapped for something unrelated. The base is the operator's ceiling; difficulty
    // can save cost, not override the pick upward.
    const basePrice = pricing.getModel(base.model)?.inputPer1M ?? null;
    const newPrice  = m.inputPer1M ?? null;
    if (basePrice != null && newPrice != null && newPrice < basePrice) {
      return { provider: m.provider, model: id };
    }
    return base;
  } catch { return base; }
}

// Operator edits — keep only entries whose model is known to the pricing table.
async function setAssignments(assignments) {
  const clean = {};
  for (const [t, model] of Object.entries(assignments || {})) {
    if (pricing.getModel(model)) clean[String(t).toLowerCase()] = model;
  }
  const s = await Settings.get();
  s.aiPolicy = { ...(s.aiPolicy || {}), assignments: clean };
  s.markModified("aiPolicy");
  await s.save();
  Settings.invalidateCache();
  invalidate();
  return s.aiPolicy;
}

// ── Scoring engine ─────────────────────────────────────────────────────────────

// Infer capability scores from model metadata text (fallback for unknown models).
function deriveCapabilities(model) {
  const text = (model.bestUsedFor || model.label || "").toLowerCase();
  const caps = { coding:0.4, reasoning:0.4, writing:0.4, analysis:0.4, language:0.4, general:0.4, data:0.4 };
  for (const [dim, kws] of Object.entries(DOMAIN_KEYWORDS)) {
    if (kws.length && kws.some((kw) => text.includes(kw))) caps[dim] = 0.7;
  }
  return caps;
}

// How much cost (vs capability) matters per tier.
// Light is intentionally low (0.20) so that coding-specialist models (e.g. Flash at $0.30)
// win over cheap generalists (nova-micro at $0.035) when the capability gap is large (>0.22).
// For general tasks the gap is small (~0.12) so the cheap model still wins.
const COST_SENSITIVITY = { light: 0.20, mid: 0.25, premium: 0.10 };

// Goal-driven cost-vs-capability weight. "balanced" (default) keeps today's per-tier behavior;
// "cost" favours cheaper models while preserving a meaningful capability floor (target 30-50% savings,
// not zero-cost); "quality" weights capability almost exclusively.
function goalWeight(goal, tier) {
  if (goal === "cost") return 0.30;
  if (goal === "quality") return 0.05;
  return COST_SENSITIVITY[tier] || 0.25; // "balanced" / unset
}

// Normalize a model id for curated-capability matching. Gateway/Bedrock ids carry an inference-profile
// prefix (e.g. "us-gov-east-1/amazon.nova-pro-v1:0") and account variants ("us.amazon." vs "amazon.")
// that an exact-id lookup misses — so "amazon.nova-pro" would score as an unknown model despite being in
// the curated table. This drops the "region/" path segment, unifies the Bedrock account prefix, and folds
// dots→dashes, while KEEPING the model-family word (unlike the benchmark normalizer, which strips it).
function capKey(id) {
  let s = String(id || "").toLowerCase();
  const slash = s.lastIndexOf("/");
  if (slash >= 0) s = s.slice(slash + 1);          // us-gov-east-1/amazon.nova-pro-v1:0 → amazon.nova-pro-v1:0
  s = s.replace(/^us\.amazon\./, "amazon.").replace(/^us\./, ""); // unify Bedrock account prefixes
  return s.replace(/\./g, "-");                    // dots→dashes so "deepseek.v3.2" ≈ "deepseek-v3-2"
}

// Curated table indexed by normalized key, so prefixed/variant ids resolve to their known scores.
const _capIndex = {};
for (const [k, v] of Object.entries(MODEL_CAPABILITIES)) _capIndex[capKey(k)] = v;

// Resolve a model's capability vector and whether it is MEASURED (from a LiveBench/LMSYS sync) or
// ESTIMATED (curated table, or keyword-derived). Single source of truth for gates, scoring, evidence.
function resolveCapabilities(model) {
  if (model.capabilities && model.capabilities.coding != null) return { caps: model.capabilities, measured: true };
  const curated = MODEL_CAPABILITIES[model.id] || _capIndex[capKey(model.id)];
  if (curated) return { caps: curated, measured: false };
  return { caps: deriveCapabilities(model), measured: false };
}

// Task-weighted capability in 0–1 — the V1 quality signal.
// SEAM (#5): blend in tenant-eval win-rate + production success-rate terms here once that data exists.
function qualityScore(taskCaps, caps) {
  let weighted = 0, totalWeight = 0;
  for (const d of DIMS) {
    const w = taskCaps[d] || 0;
    weighted    += w * (caps[d] != null ? caps[d] : 0.4);
    totalWeight += w;
  }
  return totalWeight > 0 ? weighted / totalWeight : 0.4;
}

// Returns weighted capability score + a cost-efficiency ratio (used by simulate()'s capability proxy).
// costScore = cheapestInPool / model.cost → cheapest model = 1.0, expensive → near 0.
function scoreModel(taskCaps, model, cheapestCost) {
  const { caps } = resolveCapabilities(model);
  const capScore  = qualityScore(taskCaps, caps);
  const cost      = model.inputPer1M || 0.001;
  const costScore = cheapestCost / cost;
  return { capScore, costScore };
}

// Models with a known, positive input price. An unpriced model (absent from the
// pricing catalog) otherwise scores as if free — scoreModel treats a null price as
// $0.001, so cheapestCost/price → the maximum cost score — and wins any
// cost-weighted pick despite being unpriced and often unsuited (a 4B content-safety
// model beating "document analysis"). Excluding them from auto-selection also keeps
// cost tracking honest. Falls back to the full list only if nothing is priced, so
// the pool is never emptied.
function pricedPool(models) {
  const priced = models.filter((m) => (m.inputPer1M || 0) > 0);
  return priced.length ? priced : models;
}

// ── Deterministic evidence-based engine ─────────────────────────────────────
// The policy is DECIDED here, not by an LLM: for each task we gate candidates on capability, score
// their measured capability, price them at their real expected cost, and pick the cheapest that clears
// the goal's quality bar. Reproducible and explainable. (The LLM no longer chooses; a bounded LLM
// tie-breaker/explainer is a future option — ties are broken deterministically today.)
const GATE_NEED  = 0.7;   // a task weight at/above this triggers a hard capability gate on that dimension
const GATE_FLOOR = 0.55;  // a gated dimension requires at least this much model capability
const GOAL_BAR   = { cost: 0.70, balanced: 0.80, quality: 0.0 }; // min-quality bar per goal
const DEFAULT_TASK_CAPS = { coding:0.3, reasoning:0.3, writing:0.3, analysis:0.3, language:0.1, general:0.5, data:0.2 };
const DEFAULT_TOKENS    = { avgIn: 600, avgOut: 300 }; // assumed profile when a task has no traffic yet

// A model clears a task's hard gates only if it meets the floor on every dimension the task strongly needs.
function passesGates(taskCaps, caps) {
  for (const d of DIMS) {
    if ((taskCaps[d] || 0) >= GATE_NEED && (caps[d] != null ? caps[d] : 0.4) < GATE_FLOOR) return false;
  }
  return true;
}

// Which tiers are eligible for a task's tier (premium considers all; in cost goal it floors at mid).
function poolFor(tier, liveModels, goal) {
  const byTier = { light: [], mid: [], premium: [] };
  for (const m of liveModels) { if (byTier[m.tier]) byTier[m.tier].push(m); }
  if (tier === "premium") {
    if (goal === "cost") { const p = [...byTier.mid, ...byTier.premium]; return p.length ? p : liveModels; }
    return liveModels;
  }
  const p = tier === "light" ? [...byTier.light] : [...byTier.light, ...byTier.mid];
  return p.length ? p : liveModels;
}

// Real expected cost per 1,000 requests for a model given a task's average token profile — input
// AND output priced (not input-price-only), from the pool model's own rates. Unpriced input →
// Infinity (never wins); output rate falls back to the input rate when a model omits it.
function expectedCostPer1k(model, tokens) {
  const t = tokens || DEFAULT_TOKENS;
  const inRate = model.inputPer1M;
  if (!(inRate > 0)) return Infinity;
  const outRate = model.outputPer1M != null ? model.outputPer1M : inRate;
  const perReq = (t.avgIn / 1e6) * inRate + (t.avgOut / 1e6) * outRate;
  return perReq * 1000;
}

// Templated, operator-facing rationale for the top pick (no LLM). `barMet` is false when NO candidate
// reached the quality bar and it was relaxed — so we must not claim the winner "cleared" it.
function reasonFor(c, rank, goal, bar, barMet) {
  if (rank !== 0) return "";
  if (goal === "quality") return `highest capability (${Math.round(c.quality * 100)}) for this task`;
  if (barMet) return `clears the ${bar.toFixed(2)} quality bar (${c.quality.toFixed(2)}) at the lowest expected cost`;
  return `no model meets the ${bar.toFixed(2)} quality bar (best is ${c.quality.toFixed(2)}) — picked the lowest expected cost among the closest, add benchmark data to differentiate`;
}

// Rank all candidate models for one task with evidence attached. SYNCHRONOUS (cost reads the in-memory
// registry), so the serve-time difficulty path can call it too. `tokenProfiles` may be {} → default profile.
function rankCandidates(task, liveModels, catalogMap, tokenProfiles, goal, tierOverride) {
  const tier     = tierOverride || catalogMap[task]?.tier || "mid";
  const taskCaps = TASK_CAPABILITIES[task] || DEFAULT_TASK_CAPS;
  const tokens   = tokenProfiles[task] || DEFAULT_TOKENS;
  const bar      = GOAL_BAR[goal] != null ? GOAL_BAR[goal] : 0.80;
  const pool     = poolFor(tier, liveModels, goal);

  let cands = pool.map((m) => {
    const { caps, measured } = resolveCapabilities(m);
    return {
      model: m.id, tier: m.tier, measured,
      quality: qualityScore(taskCaps, caps),
      expectedCostPer1k: expectedCostPer1k(m, tokens),
      gatePass: passesGates(taskCaps, caps),
    };
  });

  // 1) hard capability gates — relax only if they empty the pool
  let elig = cands.filter((c) => c.gatePass);
  if (!elig.length) elig = cands;
  // 2) conservative unknowns — a premium task never takes an ESTIMATED model when a MEASURED one qualifies
  if (tier === "premium") {
    const meas = elig.filter((c) => c.measured);
    if (meas.length) elig = meas;
  }
  // 3) quality bar — relax only if it empties the pool. barMet records whether the bar actually held,
  // so the evidence/reason don't claim a "cleared bar" when everything fell short and cost alone decided.
  let clearing = elig.filter((c) => c.quality >= bar);
  const barMet = clearing.length > 0;
  if (!barMet) clearing = elig;

  // 4) rank: quality goal → highest quality; else → cheapest expected cost. Deterministic tie-breaks.
  clearing.sort((a, b) => {
    if (goal === "quality") {
      if (b.quality !== a.quality) return b.quality - a.quality;
      if (a.expectedCostPer1k !== b.expectedCostPer1k) return a.expectedCostPer1k - b.expectedCostPer1k;
    } else {
      if (a.expectedCostPer1k !== b.expectedCostPer1k) return a.expectedCostPer1k - b.expectedCostPer1k;
      if (b.quality !== a.quality) return b.quality - a.quality;
    }
    if (a.measured !== b.measured) return a.measured ? -1 : 1; // measured beats estimated
    return a.model < b.model ? -1 : 1;                          // stable id order
  });

  return clearing.map((c, i) => ({
    model: c.model,
    tier: c.tier,
    quality: +c.quality.toFixed(3),
    expectedCostPer1k: isFinite(c.expectedCostPer1k) ? +c.expectedCostPer1k.toFixed(4) : null,
    measured: c.measured,
    confidence: c.measured ? (c.quality >= bar ? "high" : "medium") : "low",
    needsShadowEval: !c.measured,
    reason: reasonFor(c, i, goal, bar, barMet),
  }));
}

// Average prompt/completion tokens per task from recent customer traffic (windowed) — the real
// expected-cost inputs. Empty for a tenant with no traffic yet (→ DEFAULT_TOKENS per task).
async function taskTokenProfiles(windowDays = 14) {
  const since = new Date(Date.now() - windowDays * 86400000);
  const agg = await RequestRecord.aggregate([
    { $match: { status: "success", timestamp: { $gte: since }, ...RequestRecord.CUSTOMER_ONLY } },
    { $group: { _id: "$taskType", reqs: { $sum: 1 },
        promptTokens: { $sum: "$promptTokens" }, completionTokens: { $sum: "$completionTokens" } } },
  ]).catch(() => []);
  const out = {};
  for (const r of agg) {
    if (!r._id || !r.reqs) continue;
    out[String(r._id).toLowerCase()] = { avgIn: r.promptTokens / r.reqs, avgOut: r.completionTokens / r.reqs };
  }
  return out;
}

// Core engine — deterministic. Returns the winning model per task plus the top-N candidate evidence.
// excludeModels: array of model IDs to exclude from consideration.
async function _computeAssignments({ eff, excludeModels = [], goal = "balanced", windowDays = 14 }) {
  if (!eff) throw new Error("no effective config");
  const excludeSet = new Set(excludeModels);
  const liveIdSet  = new Set(eff.liveIds);
  const liveModels = pricedPool(pricing.listModels()
    .filter((m) => liveIdSet.has(m.provider) && !excludeSet.has(m.id) && m.chatCapable !== false))
    .sort((a, b) => (b.inputPer1M || 0) - (a.inputPer1M || 0));
  if (!liveModels.length) throw new Error("no live models available after exclusions");

  const tasks         = await allTaskTypes();
  const catalogMap    = Object.fromEntries(TASK_CATALOG.map((t) => [t.id, t]));
  const tokenProfiles = await taskTokenProfiles(windowDays);

  const assignments = {};
  const evidence    = {};
  for (const task of tasks) {
    const ranked = rankCandidates(task, liveModels, catalogMap, tokenProfiles, goal);
    assignments[task] = ranked[0]?.model || liveModels[0].id;
    evidence[task]    = ranked.slice(0, 3);
  }
  return { assignments, evidence, generatorModel: "deterministic-scorer" };
}

// Single-id resolver used by the serve-time difficulty downgrade (resolveModel, sync hot path).
// Delegates to the same gated ranker; the default token profile keeps it synchronous (no DB read).
function _scoringFallback(task, liveModels, catalogMap, eff, tierOverride, goal) {
  const ranked = rankCandidates(task, liveModels, catalogMap, {}, goal, tierOverride);
  return ranked[0]?.model || liveModels[0].id;
}

// Policy engine — computes the deterministic policy and saves it to Settings. Returns the stored
// policy plus per-task candidate `evidence` (top 3, not persisted) for the operator to inspect.
async function regenerate({ eff, goal, windowDays } = {}) {
  const { assignments, evidence, generatorModel } = await _computeAssignments({ eff, goal, windowDays });
  const s = await Settings.get();
  s.aiPolicy = { assignments, generatedAt: new Date(), generatorModel, capabilityVersion: CAPABILITY_VERSION };
  s.markModified("aiPolicy");
  await s.save();
  Settings.invalidateCache();
  invalidate();
  return { assignments, generatedAt: s.aiPolicy.generatedAt, generatorModel, capabilityVersion: CAPABILITY_VERSION, evidence };
}

// Project a proposed taskType->model policy over recent traffic. Cost is a real re-pricing of the
// logged tokens; `capabilityIndex` is a heuristic PROXY (capability scores, not measured quality).
async function simulate({ assignments = {}, application = null, windowDays = 14 } = {}) {
  const since = new Date(Date.now() - windowDays * 86400000);
  // Customer traffic only — simulating a policy against Arbr's own overhead would
  // re-price internal tokens as if a routing rule could have changed them.
  const match = { status: "success", timestamp: { $gte: since }, ...RequestRecord.CUSTOMER_ONLY };
  if (application) match.application = application;
  const agg = await RequestRecord.aggregate([
    { $match: match },
    { $group: {
        _id: { taskType: "$taskType", model: "$model" },
        requests: { $sum: 1 },
        promptTokens: { $sum: "$promptTokens" },
        completionTokens: { $sum: "$completionTokens" },
        actualCost: { $sum: "$totalCost" },
      } },
  ]);
  const groups = agg.map((r) => ({
    taskType: r._id.taskType, servedModel: r._id.model, requests: r.requests,
    promptTokens: r.promptTokens, completionTokens: r.completionTokens, actualCost: r.actualCost,
  }));
  const priceOf = (modelId, p, c) =>
    pricing.getModel(modelId) ? pricing.costFor(modelId, p, c).totalCost : null;
  const capOf = (taskType, modelId) => {
    const model = pricing.getModel(modelId);
    if (!model) return null;
    const taskCaps = TASK_CAPABILITIES[String(taskType || "").toLowerCase()]
      || { coding: 0.3, reasoning: 0.3, writing: 0.3, analysis: 0.3, language: 0.1, general: 0.5, data: 0.2 };
    return scoreModel(taskCaps, model, model.inputPer1M || 0.001).capScore;
  };
  return { windowDays, ...projectImpact(groups, assignments, priceOf, capOf) };
}

// Full view for the editor: assignments + catalogs + what's unmapped/custom.
async function describe() {
  const s = await Settings.get();
  const ai = s.aiPolicy || {};
  const assignments = ai.assignments || {};
  const observed = await observedTaskTypes();
  const customTaskTypes = observed.filter((t) => !TASK_TYPES.includes(t));
  const taskTypes = [...new Set([...TASK_TYPES, ...observed])];
  const unmapped = taskTypes.filter((t) => !assignments[t]);
  return {
    assignments,
    generatedAt:       ai.generatedAt || null,
    generatorModel:    ai.generatorModel || null,
    capabilityVersion: ai.capabilityVersion ?? null,
    needsRefresh:      (ai.capabilityVersion ?? null) !== CAPABILITY_VERSION,
    builtInTaskTypes:  TASK_TYPES,
    customTaskTypes,
    taskTypes,
    unmapped,
    taskCatalog: TASK_CATALOG,
  };
}

module.exports = { getEffective, lookup, resolveModel, setAssignments, regenerate, computeAssignments: _computeAssignments, simulate, describe, invalidate, CAPABILITY_VERSION, _goalWeight: goalWeight, _pricedPool: pricedPool, _rankCandidates: rankCandidates, _passesGates: passesGates, _qualityScore: qualityScore, _resolveCapabilities: resolveCapabilities, _capKey: capKey };
