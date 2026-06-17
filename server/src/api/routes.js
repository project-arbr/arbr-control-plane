// Admin / dashboard REST API. Read-only analytics plus the human controls:
// recommendations, rules, routing mode + policies, budgets, gateway API keys,
// provider connections. Gated by api/adminAuth.js when ARBR_ADMIN_KEY is set.
const express = require("express");
const RequestRecord = require("../models/RequestRecord");
const Rule = require("../models/Rule");
const Recommendation = require("../models/Recommendation");
const Cap = require("../models/Cap");
const ApiKey = require("../models/ApiKey");
const auth = require("../gateway/auth");
const capEngine = require("../routing/capEngine");
const crypto = require("crypto");
const analytics = require("../analytics/aggregate");
const recommender = require("../recommend/engine");
const ruleEngine = require("../routing/ruleEngine");
const responseCache = require("../routing/responseCache");
const policyEngine = require("../routing/policy");
const aiPolicy = require("../routing/aiPolicy");
const { TASK_TYPES } = require("../classify/classifier");
const connections = require("../providers/connections");
const { createRouter } = require("../providers/llm-router");
const { toRouterConfig, getRouter } = require("../providers/router");
const pricing = require("../pricing/registry");
const ModelEntry = require("../models/ModelEntry");
const { config } = require("../config");

const router = express.Router();

// Rolling window start for a cap period.
function capWindowStart(period) {
  const ms = period === "day" ? 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000;
  return new Date(Date.now() - ms);
}

// A cap enriched with its current spend / breach status.
async function capStatus(cap) {
  const spent = await analytics.spend({
    dimension: cap.dimension,
    value: cap.value,
    from: capWindowStart(cap.period),
  });
  const pct = cap.limit > 0 ? spent / cap.limit : 0;
  return { ...cap, spent, pct, breached: cap.enabled && spent >= cap.limit };
}

// ── status / health ──
router.get("/status", async (_req, res, next) => {
  try {
    const [routingMode, requireApiKey, eff, caps] = await Promise.all([
      ruleEngine.getRoutingMode(),
      auth.requireApiKeyOn(),
      connections.effective(),
      Cap.find({ enabled: true }).lean(),
    ]);
    const breachedCaps = (await Promise.all(caps.map(capStatus))).filter((c) => c.breached).length;
    res.json({
      demoMode: eff.demoMode,
      liveProviders: eff.liveIds,
      defaultProvider: eff.defaultProvider,
      defaultModel: eff.defaultModel,
      routingMode,
      requireApiKey,
      breachedCaps,
    });
  } catch (e) { next(e); }
});

// ── cost caps (budgets) ──
router.get("/caps", async (_req, res, next) => {
  try {
    const caps = await Cap.find().sort({ createdAt: -1 }).lean();
    res.json(await Promise.all(caps.map(capStatus)));
  } catch (e) { next(e); }
});

const CAP_ACTIONS = ["alert", "downgrade", "block"];

router.post("/caps", async (req, res, next) => {
  try {
    const { dimension, value, period, limit, action } = req.body || {};
    if (!(Number(limit) > 0)) return res.status(400).json({ error: "limit must be a positive number" });
    const allowed = ["application", "provider", "department", "workflow", "model"];
    const dim = dimension && allowed.includes(dimension) ? dimension : null;
    if (dim && !value) return res.status(400).json({ error: `value is required for a ${dim} cap` });
    const cap = await Cap.create({
      dimension: dim,
      value: dim ? value : null,
      period: period === "day" ? "day" : "month",
      limit: Number(limit),
      action: CAP_ACTIONS.includes(action) ? action : "alert",
      enabled: true,
    });
    capEngine.invalidate();
    res.json(await capStatus(cap.toObject()));
  } catch (e) { next(e); }
});

router.patch("/caps/:id", async (req, res, next) => {
  try {
    const update = {};
    if (typeof req.body.enabled === "boolean") update.enabled = req.body.enabled;
    if (Number(req.body.limit) > 0) update.limit = Number(req.body.limit);
    if (req.body.period === "day" || req.body.period === "month") update.period = req.body.period;
    if (CAP_ACTIONS.includes(req.body.action)) update.action = req.body.action;
    const cap = await Cap.findByIdAndUpdate(req.params.id, update, { new: true }).lean();
    capEngine.invalidate();
    res.json(cap ? await capStatus(cap) : { error: "not found" });
  } catch (e) { next(e); }
});

router.delete("/caps/:id", async (req, res, next) => {
  try {
    await Cap.findByIdAndDelete(req.params.id);
    capEngine.invalidate();
    res.json({ deleted: true });
  } catch (e) { next(e); }
});

// ── gateway API keys (virtual keys) ──
function keyView(d) {
  return {
    _id: d._id, name: d.name, application: d.application, prefix: d.prefix,
    enabled: d.enabled, rpm: d.rpm, createdAt: d.createdAt, lastUsedAt: d.lastUsedAt,
  };
}

router.get("/keys", async (_req, res, next) => {
  try {
    const keys = await ApiKey.find({ revokedAt: null }).sort({ createdAt: -1 }).lean();
    res.json(keys.map(keyView));
  } catch (e) { next(e); }
});

router.post("/keys", async (req, res, next) => {
  try {
    const { name, application, rpm } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: "name is required" });
    if (!application || !String(application).trim()) return res.status(400).json({ error: "application is required" });
    const secret = "ab_" + crypto.randomBytes(16).toString("hex");
    const doc = await ApiKey.create({
      name: String(name).trim(),
      application: String(application).trim(),
      keyHash: auth.hashKey(secret),
      prefix: `ab_…${secret.slice(-4)}`,
      rpm: Number(rpm) > 0 ? Number(rpm) : null,
    });
    auth.invalidate();
    // The ONLY time the full secret is ever returned.
    res.json({ ...keyView(doc.toObject()), key: secret });
  } catch (e) { next(e); }
});

router.patch("/keys/:id", async (req, res, next) => {
  try {
    const update = {};
    if (typeof req.body.enabled === "boolean") update.enabled = req.body.enabled;
    if (req.body.rpm === null || Number(req.body.rpm) > 0) update.rpm = req.body.rpm === null ? null : Number(req.body.rpm);
    const doc = await ApiKey.findByIdAndUpdate(req.params.id, update, { new: true }).lean();
    auth.invalidate();
    res.json(doc ? keyView(doc) : { error: "not found" });
  } catch (e) { next(e); }
});

router.delete("/keys/:id", async (req, res, next) => {
  try {
    await ApiKey.findByIdAndUpdate(req.params.id, { enabled: false, revokedAt: new Date() });
    auth.invalidate();
    res.json({ revoked: true });
  } catch (e) { next(e); }
});

// Master switch: require a valid API key on /v1/*.
router.get("/require-api-key", async (_req, res, next) => {
  try { res.json({ requireApiKey: await auth.requireApiKeyOn() }); } catch (e) { next(e); }
});

router.put("/require-api-key", async (req, res, next) => {
  try { res.json({ requireApiKey: await auth.setRequireApiKey(!!req.body.on) }); } catch (e) { next(e); }
});

// ── connections (provider keys) ──
router.get("/connections", async (_req, res, next) => {
  try { res.json(await connections.statuses()); } catch (e) { next(e); }
});

// Add / replace a provider credential (stored encrypted; never echoed back).
// Body shape depends on the provider: { apiKey } or { accessKeyId, secretAccessKey, region }.
router.put("/connections/:provider", async (req, res, next) => {
  try {
    await connections.setCredential(req.params.provider, req.body || {});
    res.json(await connections.statuses());
  } catch (e) { res.status(400).json({ error: "bad_request", message: String(e.message || e) }); }
});

// Remove a stored credential (an env credential for the same provider still applies).
router.delete("/connections/:provider", async (req, res, next) => {
  try {
    await connections.removeCredential(req.params.provider);
    res.json(await connections.statuses());
  } catch (e) { next(e); }
});

// Choose the default provider used when a request names none.
router.put("/default-provider", async (req, res, next) => {
  try {
    await connections.setDefaultProvider(req.body?.provider || null);
    res.json(await connections.statuses());
  } catch (e) { res.status(400).json({ error: "bad_request", message: String(e.message || e) }); }
});

// Choose the default model (applies to the default provider; used in auto mode).
router.put("/default-model", async (req, res, next) => {
  try {
    await connections.setDefaultModel(req.body?.model || null);
    res.json(await connections.statuses());
  } catch (e) { res.status(400).json({ error: "bad_request", message: String(e.message || e) }); }
});

// Live "test" — make a tiny real call with the effective key for one provider.
router.post("/connections/:provider/test", async (req, res) => {
  try {
    const provider = req.params.provider;
    const eff = await connections.effective();
    const p = eff.providers[provider];
    if (!p) return res.status(400).json({ ok: false, message: "provider not configured" });
    const r = createRouter({
      providers: { [provider]: toRouterConfig(p) },
      defaultProvider: provider,
    });
    // Generous budget so "thinking" models (e.g. Gemini 2.5) have room to answer.
    const out = await r.complete({ messages: [{ role: "user", content: "Reply with: ok" }], maxTokens: 256 });
    res.json({ ok: true, model: out.modelId, sample: (out.text || "").slice(0, 40) });
  } catch (e) {
    res.json({ ok: false, message: String(e.message || e) });
  }
});

// ── model registry ──
router.get("/models", (_req, res) => {
  res.json(pricing.listModels().map((m) => ({
    id: m.id, provider: m.provider, tier: m.tier, label: m.label || "",
    inputPer1M: m.inputPer1M, outputPer1M: m.outputPer1M,
    builtIn: m.builtIn, enabled: m.enabled,
  })));
});

router.post("/models", async (req, res, next) => {
  try {
    const { id, provider, label, inputPer1M, outputPer1M, tier } = req.body || {};
    if (!id || !String(id).trim()) return res.status(400).json({ error: "id is required" });
    if (!provider || !String(provider).trim()) return res.status(400).json({ error: "provider is required" });
    if (!["light", "mid", "premium"].includes(tier)) return res.status(400).json({ error: "tier must be light, mid, or premium" });
    if (!(Number(inputPer1M) >= 0) || !(Number(outputPer1M) >= 0)) return res.status(400).json({ error: "prices must be non-negative numbers" });
    const doc = await ModelEntry.create({
      id: String(id).trim(),
      provider: String(provider).trim(),
      label: label ? String(label).trim() : "",
      inputPer1M: Number(inputPer1M),
      outputPer1M: Number(outputPer1M),
      tier,
      builtIn: false,
      enabled: true,
    });
    await pricing.reload();
    res.status(201).json(doc);
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ error: "model_exists", message: `Model "${req.body?.id}" already exists` });
    next(e);
  }
});

router.patch("/models/:id", async (req, res, next) => {
  try {
    const doc = await ModelEntry.findOne({ id: req.params.id });
    if (!doc) return res.status(404).json({ error: "not_found" });
    const update = {};
    if (req.body.label != null) update.label = String(req.body.label).trim();
    if (["light", "mid", "premium"].includes(req.body.tier)) update.tier = req.body.tier;
    if (Number(req.body.inputPer1M) >= 0) update.inputPer1M = Number(req.body.inputPer1M);
    if (Number(req.body.outputPer1M) >= 0) update.outputPer1M = Number(req.body.outputPer1M);
    if (typeof req.body.enabled === "boolean") update.enabled = req.body.enabled;
    await ModelEntry.updateOne({ id: req.params.id }, { $set: update });
    await pricing.reload();
    res.json(await ModelEntry.findOne({ id: req.params.id }).lean());
  } catch (e) { next(e); }
});

router.delete("/models/:id", async (req, res, next) => {
  try {
    const doc = await ModelEntry.findOne({ id: req.params.id });
    if (!doc) return res.status(404).json({ error: "not_found" });
    if (doc.builtIn) return res.status(400).json({ error: "cannot_delete_builtin", message: "Built-in models cannot be deleted; set enabled=false instead." });
    await ModelEntry.deleteOne({ id: req.params.id });
    await pricing.reload();
    res.json({ deleted: true });
  } catch (e) { next(e); }
});

// ── analytics ──
router.get("/analytics/overview", async (req, res, next) => {
  try { res.json(await analytics.overview(req.query)); } catch (e) { next(e); }
});

const VIEWS = {
  application: analytics.byApplication,
  team: analytics.byTeam,
  workflow: analytics.byWorkflow,
  model: analytics.byModel,
  provider: analytics.byProvider,
  taskType: analytics.byTaskType,
};
router.get("/analytics/by/:dimension", async (req, res, next) => {
  try {
    const fn = VIEWS[req.params.dimension];
    if (!fn) return res.status(404).json({ error: "unknown dimension" });
    res.json(await fn(req.query));
  } catch (e) { next(e); }
});

router.get("/analytics/facets", async (_req, res, next) => {
  try { res.json(await analytics.facets()); } catch (e) { next(e); }
});

// ── request records (filterable, paginated) ──
router.get("/requests", async (req, res, next) => {
  try {
    const match = analytics.buildMatch(req.query);
    const limit = Math.min(Number(req.query.limit) || 50, 500);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const [items, total] = await Promise.all([
      RequestRecord.find(match).sort({ timestamp: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      RequestRecord.countDocuments(match),
    ]);
    res.json({ items, total, page, limit });
  } catch (e) { next(e); }
});

// ── recommendations ──
router.get("/recommendations", async (req, res, next) => {
  try {
    const q = req.query.status ? { status: req.query.status } : {};
    res.json(await Recommendation.find(q).sort({ projectedSavings: -1 }).lean());
  } catch (e) { next(e); }
});

router.post("/recommendations/recompute", async (_req, res, next) => {
  try { res.json(await recommender.recompute()); } catch (e) { next(e); }
});

// Accept → create a disabled rule from the recommendation, mark accepted.
router.post("/recommendations/:id/accept", async (req, res, next) => {
  try {
    const rec = await Recommendation.findById(req.params.id);
    if (!rec) return res.status(404).json({ error: "not found" });
    const rule = await Rule.create({
      condition: { taskType: rec.taskType, application: null, workflow: null },
      target: { provider: rec.suggestedProvider, model: rec.suggestedModel },
      enabled: false, // human must explicitly switch it on
      createdBy: "console",
      sourceRecommendation: rec._id,
      note: rec.title,
    });
    rec.status = "accepted";
    await rec.save();
    ruleEngine.invalidate();
    res.json({ recommendation: rec, rule });
  } catch (e) { next(e); }
});

router.post("/recommendations/:id/dismiss", async (req, res, next) => {
  try {
    const rec = await Recommendation.findByIdAndUpdate(
      req.params.id, { status: "dismissed" }, { new: true }
    );
    if (!rec) return res.status(404).json({ error: "not found" });
    res.json(rec);
  } catch (e) { next(e); }
});

// ── rules ──
router.get("/rules", async (_req, res, next) => {
  try { res.json(await Rule.find().sort({ createdAt: -1 }).lean()); } catch (e) { next(e); }
});

router.post("/rules", async (req, res, next) => {
  try {
    const { condition = {}, target, enabled = false, note = "" } = req.body || {};
    if (!target || !target.provider || !target.model) {
      return res.status(400).json({ error: "target { provider, model } is required" });
    }
    const rule = await Rule.create({
      condition: {
        taskType: condition.taskType || null,
        application: condition.application || null,
        workflow: condition.workflow || null,
      },
      target, enabled: !!enabled, note,
    });
    ruleEngine.invalidate();
    res.json(rule);
  } catch (e) { next(e); }
});

// Toggle / update enabled state.
router.patch("/rules/:id", async (req, res, next) => {
  try {
    const update = {};
    if (typeof req.body.enabled === "boolean") update.enabled = req.body.enabled;
    if (req.body.note != null) update.note = req.body.note;
    const rule = await Rule.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!rule) return res.status(404).json({ error: "not found" });
    ruleEngine.invalidate();
    res.json(rule);
  } catch (e) { next(e); }
});

router.delete("/rules/:id", async (req, res, next) => {
  try {
    await Rule.findByIdAndDelete(req.params.id);
    ruleEngine.invalidate();
    res.json({ ok: true });
  } catch (e) { next(e); }
});


// Clear the in-memory response cache (useful when testing routing on repeated prompts).
router.post("/cache/clear", (_req, res) => {
  responseCache.clear();
  res.json({ cleared: true });
});

// Auto-mode routing engine: "off" | "guardrail" | "ai".
router.get("/routing-mode", async (_req, res, next) => {
  try { res.json({ routingMode: await ruleEngine.getRoutingMode() }); } catch (e) { next(e); }
});

router.put("/routing-mode", async (req, res, next) => {
  try {
    const mode = await ruleEngine.setRoutingMode(req.body?.mode);
    res.json({ routingMode: mode });
  } catch (e) { next(e); }
});

// ── AI routing policy (task → model, generated/editable) ──
router.get("/ai-policy", async (_req, res, next) => {
  try { res.json(await aiPolicy.describe()); } catch (e) { next(e); }
});

router.put("/ai-policy", async (req, res, next) => {
  try {
    await aiPolicy.setAssignments(req.body?.assignments || {});
    res.json(await aiPolicy.describe());
  } catch (e) { res.status(400).json({ error: "bad_request", message: String(e.message || e) }); }
});

router.post("/ai-policy/regenerate", async (_req, res, next) => {
  try {
    const { router: r, eff } = await getRouter();
    if (!r) return res.status(503).json({ error: "demo_mode", message: "Add a provider key to generate an AI policy." });
    await aiPolicy.regenerate({ router: r, eff });
    res.json(await aiPolicy.describe());
  } catch (e) { res.status(400).json({ error: "bad_request", message: String(e.message || e) }); }
});

// ── automated-routing policy (editable knobs behind the cost guardrail) ──
router.get("/policy", async (_req, res, next) => {
  try {
    const d = await policyEngine.describe();
    res.json({ ...d, taskTypes: TASK_TYPES });
  } catch (e) { next(e); }
});

router.put("/policy", async (req, res, next) => {
  try {
    const body = req.body || {};
    // Validate task types against the known catalog.
    let cheapTaskTypes;
    if (Array.isArray(body.cheapTaskTypes)) {
      const known = new Set(TASK_TYPES);
      cheapTaskTypes = body.cheapTaskTypes.map((x) => String(x).toLowerCase()).filter((x) => known.has(x));
    }
    // Validate targets: each must be a known model that belongs to its provider key.
    let lightTargets;
    if (body.lightTargets && typeof body.lightTargets === "object") {
      lightTargets = {};
      for (const [provider, model] of Object.entries(body.lightTargets)) {
        const m = pricing.getModel(model);
        if (m && m.provider === provider) lightTargets[provider] = model;
      }
    }
    const saved = await policyEngine.setPolicy({ cheapTaskTypes, lightTargets, mode: body.mode });
    res.json(saved);
  } catch (e) { next(e); }
});

module.exports = router;
