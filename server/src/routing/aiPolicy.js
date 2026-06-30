// AI-generated routing policy: a task-type → model assignment the AI produces from
// the available models (and observed custom task types), editable by an operator and
// regeneratable. Used in auto mode when routingMode === "ai". Cached like the rule set.
const Settings = require("../models/Settings");
const RequestRecord = require("../models/RequestRecord");
const pricing = require("../pricing/registry");
const { TASK_TYPES, TASK_CATALOG } = require("../classify/classifier");
const { projectImpact } = require("./policySim");

// Increment when MODEL_CAPABILITIES or TASK_CAPABILITIES change.
// GET /api/ai-policy auto-regenerates if the stored version is behind.
// HOW TO UPDATE: change the tables below, then increment this number by 1.
const CAPABILITY_VERSION = 2;

let _cache = { map: null, at: 0 };
const TTL_MS = 5000;
function invalidate() { _cache.at = 0; }

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
  const seen = await RequestRecord.distinct("taskType");
  return seen.filter(Boolean).map((t) => String(t).toLowerCase());
}

// Built-in catalog ∪ observed (so custom task types get covered).
async function allTaskTypes() {
  const seen = await observedTaskTypes();
  return [...new Set([...TASK_TYPES, ...seen])];
}

// The current assignments map (cached). { [taskType]: modelId }
async function getEffective() {
  if (_cache.map && Date.now() - _cache.at < TTL_MS) return _cache.map;
  const s = await Settings.get();
  const map = (s.aiPolicy && s.aiPolicy.assignments) || {};
  _cache = { map, at: Date.now() };
  return map;
}

// Resolve a task type to { provider, model } via the map, or null. Liveness is
// checked by the caller (it has the effective live set).
function lookup(map, taskType) {
  const model = map[String(taskType || "").toLowerCase()];
  if (!model) return null;
  const m = pricing.getModel(model);
  return m ? { provider: m.provider, model } : null;
}

// Difficulty-aware resolution. Start from the policy's pick for the task type; if the
// classifier rated THIS instance easier or harder than the task's default tier, re-pick
// within that tier using the same scoring engine. Falls back to the base pick on anything
// unexpected (no difficulty, unknown task, scoring error, or a non-live result).
function resolveModel({ map, taskType, difficulty, eff }) {
  const base = lookup(map, taskType);
  // Only ADJUST an existing policy pick; never invent one for an unmapped task (that stays
  // passthrough, as before). And no difficulty/eff → unchanged behavior.
  if (!base || !difficulty || !eff || !eff.liveIds) return base;
  const tt = String(taskType || "").toLowerCase();
  const catalogTier = TASK_CATALOG.find((t) => t.id === tt)?.tier || null;
  if (difficulty === catalogTier) return base;
  try {
    const liveIdSet = new Set(eff.liveIds);
    const liveModels = pricing.listModels()
      .filter((m) => liveIdSet.has(m.provider))
      .sort((a, b) => (b.inputPer1M || 0) - (a.inputPer1M || 0));
    if (!liveModels.length) return base;
    const catalogMap = Object.fromEntries(TASK_CATALOG.map((t) => [t.id, t]));
    const id = _scoringFallback(tt, liveModels, catalogMap, eff, difficulty);
    const m = pricing.getModel(id);
    if (m && liveIdSet.has(m.provider)) return { provider: m.provider, model: id };
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

// Brace-depth scanner: finds the last complete {...} block in LLM response text.
function parseJsonBlock(text) {
  let depth = 0, end = -1;
  for (let i = (text || "").length - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === "}") { if (depth === 0) end = i; depth++; }
    else if (ch === "{") {
      depth--;
      if (depth === 0 && end !== -1) {
        try { return JSON.parse(text.slice(i, end + 1)); } catch { end = -1; depth = 0; }
      }
    }
  }
  return null;
}

// How much cost (vs capability) matters per tier.
// Light is intentionally low (0.20) so that coding-specialist models (e.g. Flash at $0.30)
// win over cheap generalists (nova-micro at $0.035) when the capability gap is large (>0.22).
// For general tasks the gap is small (~0.12) so the cheap model still wins.
const COST_SENSITIVITY = { light: 0.20, mid: 0.25, premium: 0.10 };

// Goal-driven cost-vs-capability weight. "balanced" (default) keeps today's per-tier behavior;
// "cost" weights cost heavily (cheapest capable model); "quality" weights capability (best model).
function goalWeight(goal, tier) {
  if (goal === "cost") return 0.6;
  if (goal === "quality") return 0.05;
  return COST_SENSITIVITY[tier] || 0.25; // "balanced" / unset
}

// Scoring function: returns weighted capability score and cost efficiency ratio.
// costScore = cheapestInPool / model.cost  →  cheapest model = 1.0, expensive → near 0.
function scoreModel(taskCaps, model, cheapestCost) {
  const caps = (model.capabilities?.coding != null ? model.capabilities : null)
            || MODEL_CAPABILITIES[model.id]
            || deriveCapabilities(model);
  let weighted = 0, totalWeight = 0;
  for (const d of DIMS) {
    const w = taskCaps[d] || 0;
    weighted    += w * (caps[d] || 0.4);
    totalWeight += w;
  }
  const capScore  = totalWeight > 0 ? weighted / totalWeight : 0.4;
  const cost      = model.inputPer1M || 0.001;
  const costScore = cheapestCost / cost;
  return { capScore, costScore };
}

// Core scoring engine — shared by regenerate() and computeAssignments().
// excludeModels: array of model IDs to exclude from consideration.
async function _computeAssignments({ router, eff, excludeModels = [], goal = "balanced" }) {
  if (!eff) throw new Error("no effective config");

  const excludeSet = new Set(excludeModels);
  const liveIdSet  = new Set(eff.liveIds);
  const liveModels = pricing.listModels()
    .filter((m) => liveIdSet.has(m.provider) && !excludeSet.has(m.id))
    .sort((a, b) => (b.inputPer1M || 0) - (a.inputPer1M || 0));

  if (!liveModels.length) throw new Error("no live models available after exclusions");

  // Use the configured default model as the generator — it's the one the admin
  // has verified works. Fall back to the first live model only if no default is set.
  const defaultEntry = eff.defaultModel
    ? pricing.getModel(eff.defaultModel)
    : null;
  const generatorModel = (defaultEntry && liveIdSet.has(defaultEntry.provider))
    ? defaultEntry
    : liveModels[0];
  const tasks          = await allTaskTypes();
  const catalogMap     = Object.fromEntries(TASK_CATALOG.map((t) => [t.id, t]));
  const validIds       = new Set(liveModels.map((m) => m.id));

  // ── Attempt a single LLM call to generate all assignments at once ─────────
  try {
    const modelList = liveModels.map((m) =>
      `  - ${m.id} (tier: ${m.tier || "?"}, $${(m.inputPer1M || 0).toFixed(2)}/1M tokens in)`
    ).join("\n");

    const taskList = tasks.map((t) => {
      const meta = catalogMap[t];
      return `  - ${t}${meta ? ` — ${meta.description || meta.label || ""}` : ""}`;
    }).join("\n");

    const prompt =
      `You are routing policy generator for an AI gateway. Assign the single best model to each task type.\n\n` +
      `Available models (choose ONLY from this list):\n${modelList}\n\n` +
      `Task types to assign:\n${taskList}\n\n` +
      `Rules:\n` +
      `- Use light-tier models for simple/cheap tasks, premium for complex reasoning\n` +
      `- Vary assignments — don't give every task the same model\n` +
      `- Choose the model best suited for each task's requirements\n` +
      (goal === "cost"
        ? `- GOAL: minimize cost — prefer the cheapest model that can do each task acceptably\n`
        : goal === "quality"
        ? `- GOAL: maximize quality — prefer the most capable model for each task, cost is secondary\n`
        : `- GOAL: balance capability and cost\n`) +
      `\n` +
      `Return ONLY a valid JSON object mapping each task ID to one model ID. Example:\n` +
      `{"faq":"model-a","coding":"model-b","translation":"model-c"}`;

    const resp = await router.complete({
      messages: [{ role: "user", content: prompt }],
      providerOverride: generatorModel.provider,
      modelOverride:    generatorModel.id,
      temperature: 0.2,
      maxTokens:   1200,
    });

    const raw = parseJsonBlock(resp.text || "");
    if (raw && typeof raw === "object") {
      const assignments = {};
      for (const task of tasks) {
        const assigned = raw[task];
        // accept the LLM's choice only if it picked a valid live model
        assignments[task] = validIds.has(assigned) ? assigned : _scoringFallback(task, liveModels, catalogMap, eff, undefined, goal);
      }
      return { assignments, generatorModel };
    }
  } catch (_e) { /* fall through to scoring matrix */ }

  // ── Scoring matrix fallback ───────────────────────────────────────────────
  const assignments = {};
  for (const task of tasks) {
    assignments[task] = _scoringFallback(task, liveModels, catalogMap, eff, undefined, goal);
  }
  return { assignments, generatorModel };
}

function _scoringFallback(task, liveModels, catalogMap, eff, tierOverride, goal) {
  const byTier = { light: [], mid: [], premium: [] };
  for (const m of liveModels) { if (byTier[m.tier]) byTier[m.tier].push(m); }
  const hardFallback = liveModels[0].id;

  function poolFor(tier) {
    if (tier === "premium") return liveModels;
    const p = tier === "light"
      ? [...(byTier.light || [])]
      : [...(byTier.light || []), ...(byTier.mid || [])];
    return p.length ? p : liveModels;
  }

  const tier     = tierOverride || catalogMap[task]?.tier || "mid";
  const taskCaps = TASK_CAPABILITIES[task] || { coding:0.3, reasoning:0.3, writing:0.3, analysis:0.3, language:0.1, general:0.5, data:0.2 };
  const pool     = poolFor(tier);
  const cheapest = Math.min(...pool.map((m) => m.inputPer1M || 0.001));
  const cs       = goalWeight(goal, tier);
  let best = pool[0], bestScore = -1;
  for (const m of pool) {
    const { capScore, costScore } = scoreModel(taskCaps, m, cheapest);
    const final = (1 - cs) * capScore + cs * costScore;
    if (final > bestScore) { bestScore = final; best = m; }
  }
  return best?.id || hardFallback;
}

// Policy engine — saves global AI policy to Settings.
async function regenerate({ router, eff, goal }) {
  const { assignments, generatorModel } = await _computeAssignments({ router, eff, goal });
  const s = await Settings.get();
  s.aiPolicy = { assignments, generatedAt: new Date(), generatorModel: generatorModel.id, capabilityVersion: CAPABILITY_VERSION };
  s.markModified("aiPolicy");
  await s.save();
  invalidate();
  return s.aiPolicy;
}

// Project a proposed taskType->model policy over recent traffic. Cost is a real re-pricing of the
// logged tokens; `capabilityIndex` is a heuristic PROXY (capability scores, not measured quality).
async function simulate({ assignments = {}, application = null, windowDays = 14 } = {}) {
  const since = new Date(Date.now() - windowDays * 86400000);
  const match = { status: "success", timestamp: { $gte: since } };
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

module.exports = { getEffective, lookup, resolveModel, setAssignments, regenerate, computeAssignments: _computeAssignments, simulate, describe, invalidate, CAPABILITY_VERSION };
