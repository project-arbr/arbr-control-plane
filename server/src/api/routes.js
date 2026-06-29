// Admin / dashboard REST API. Read-only analytics plus the human controls:
// recommendations, rules, routing mode + policies, budgets, gateway API keys,
// provider connections. Gated by api/adminAuth.js when ARBR_ADMIN_KEY is set.
const express = require("express");
const RequestRecord = require("../models/RequestRecord");
const Rule = require("../models/Rule");
const Recommendation = require("../models/Recommendation");
const Cap = require("../models/Cap");
const ApiKey = require("../models/ApiKey");
const AuditLog = require("../models/AuditLog");
const auth = require("../gateway/auth");
const { logAction } = require("./auditLogger");
const { supportsTools } = require("../gateway/capabilities");
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
const CustomProvider = require("../models/CustomProvider");
const Settings = require("../models/Settings");
const secrets = require("../security/secrets");
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

router.get("/about", (_req, res) => {
  const pkg = require("../../package.json");
  res.json({
    version: pkg.version,
    name: pkg.name,
    sdkJs: "0.2.0",
    sdkPython: "0.2.0",
    nodeVersion: process.version,
  });
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
    setImmediate(() => logAction("cap.create", "cap", cap._id, { dimension: dim, value, period, limit, action }));
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
    setImmediate(() => logAction("cap.update", "cap", req.params.id, update));
    res.json(cap ? await capStatus(cap) : { error: "not found" });
  } catch (e) { next(e); }
});

router.delete("/caps/:id", async (req, res, next) => {
  try {
    await Cap.findByIdAndDelete(req.params.id);
    capEngine.invalidate();
    setImmediate(() => logAction("cap.delete", "cap", req.params.id, null));
    res.json({ deleted: true });
  } catch (e) { next(e); }
});

// ── gateway API keys (virtual keys) ──
function keyView(d) {
  return {
    _id: d._id, name: d.name, application: d.application, prefix: d.prefix,
    enabled: d.enabled, rpm: d.rpm, createdAt: d.createdAt, lastUsedAt: d.lastUsedAt,
    allowedModels: d.allowedModels || [], defaultModel: d.defaultModel || null,
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
    const { name, application, rpm, allowedModels, defaultModel } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: "name is required" });
    if (!application || !String(application).trim()) return res.status(400).json({ error: "application is required" });
    const secret = "ab_" + crypto.randomBytes(16).toString("hex");
    const doc = await ApiKey.create({
      name: String(name).trim(),
      application: String(application).trim(),
      keyHash: auth.hashKey(secret),
      prefix: `ab_…${secret.slice(-4)}`,
      rpm: Number(rpm) > 0 ? Number(rpm) : null,
      allowedModels: Array.isArray(allowedModels) ? allowedModels.filter(Boolean) : [],
      defaultModel: defaultModel ? String(defaultModel).trim() || null : null,
    });
    auth.invalidate();
    setImmediate(() => logAction("key.create", "key", doc._id, { name: doc.name, application: doc.application }));
    // The ONLY time the full secret is ever returned.
    res.json({ ...keyView(doc.toObject()), key: secret });
  } catch (e) { next(e); }
});

router.patch("/keys/:id", async (req, res, next) => {
  try {
    const update = {};
    if (req.body.name) update.name = String(req.body.name).trim();
    if (req.body.application) update.application = String(req.body.application).trim();
    if (typeof req.body.enabled === "boolean") update.enabled = req.body.enabled;
    if (req.body.rpm === null || Number(req.body.rpm) > 0) update.rpm = req.body.rpm === null ? null : Number(req.body.rpm);
    if (Array.isArray(req.body.allowedModels)) update.allowedModels = req.body.allowedModels.filter(Boolean);
    if ("defaultModel" in req.body) update.defaultModel = req.body.defaultModel ? String(req.body.defaultModel).trim() || null : null;
    const doc = await ApiKey.findByIdAndUpdate(req.params.id, update, { new: true }).lean();
    auth.invalidate();
    res.json(doc ? keyView(doc) : { error: "not found" });
  } catch (e) { next(e); }
});

router.delete("/keys/:id", async (req, res, next) => {
  try {
    await ApiKey.findByIdAndUpdate(req.params.id, { enabled: false, revokedAt: new Date() });
    auth.invalidate();
    setImmediate(() => logAction("key.revoke", "key", req.params.id, null));
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
      providers: { [provider]: toRouterConfig(provider, p) },
      defaultProvider: provider,
    });
    // Generous budget so "thinking" models (e.g. Gemini 2.5) have room to answer.
    const out = await r.complete({ messages: [{ role: "user", content: "Reply with: ok" }], maxTokens: 256 });
    res.json({ ok: true, model: out.modelId, sample: (out.text || "").slice(0, 40) });
  } catch (e) {
    res.json({ ok: false, message: String(e.message || e) });
  }
});

// ── custom providers ──
function cpView(d) {
  return { id: d.id, label: d.label, baseURL: d.baseURL, last4: d.last4, enabled: d.enabled, createdAt: d.createdAt };
}

router.get("/custom-providers", async (_req, res, next) => {
  try {
    const docs = await CustomProvider.find().sort({ createdAt: -1 }).lean();
    res.json(docs.map(cpView));
  } catch (e) { next(e); }
});

router.post("/custom-providers", async (req, res, next) => {
  try {
    const { id, label, baseURL, apiKey } = req.body || {};
    if (!id || !String(id).trim()) return res.status(400).json({ error: "id is required" });
    if (!label || !String(label).trim()) return res.status(400).json({ error: "label is required" });
    if (!baseURL || !String(baseURL).trim()) return res.status(400).json({ error: "baseURL is required" });
    if (!apiKey || !String(apiKey).trim()) return res.status(400).json({ error: "apiKey is required" });
    const cleanKey = String(apiKey).trim();
    const enc = secrets.encrypt(cleanKey);
    const doc = await CustomProvider.create({
      id: String(id).trim().toLowerCase().replace(/[^a-z0-9-_]/g, "-"),
      label: String(label).trim(),
      baseURL: String(baseURL).trim().replace(/\/+$/, ""),
      ...enc,
      last4: cleanKey.slice(-4),
      enabled: true,
    });
    connections.invalidate();
    res.status(201).json(cpView(doc.toObject()));
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ error: "provider_exists", message: `Custom provider "${req.body?.id}" already exists` });
    next(e);
  }
});

router.patch("/custom-providers/:id", async (req, res, next) => {
  try {
    const doc = await CustomProvider.findOne({ id: req.params.id });
    if (!doc) return res.status(404).json({ error: "not_found" });
    const update = {};
    if (req.body.label) update.label = String(req.body.label).trim();
    if (req.body.baseURL) update.baseURL = String(req.body.baseURL).trim().replace(/\/+$/, "");
    if (req.body.apiKey && String(req.body.apiKey).trim()) {
      const cleanKey = String(req.body.apiKey).trim();
      Object.assign(update, secrets.encrypt(cleanKey));
      update.last4 = cleanKey.slice(-4);
    }
    if (typeof req.body.enabled === "boolean") update.enabled = req.body.enabled;
    await CustomProvider.updateOne({ id: req.params.id }, { $set: update });
    connections.invalidate();
    res.json(cpView(await CustomProvider.findOne({ id: req.params.id }).lean()));
  } catch (e) { next(e); }
});

router.delete("/custom-providers/:id", async (req, res, next) => {
  try {
    const doc = await CustomProvider.findOne({ id: req.params.id });
    if (!doc) return res.status(404).json({ error: "not_found" });
    await CustomProvider.deleteOne({ id: req.params.id });
    connections.invalidate();
    res.json({ deleted: true });
  } catch (e) { next(e); }
});

router.post("/custom-providers/:id/test", async (req, res) => {
  try {
    const doc = await CustomProvider.findOne({ id: req.params.id }).lean();
    if (!doc || !doc.enabled) return res.status(400).json({ ok: false, message: "provider not found or disabled" });
    const apiKey = secrets.decrypt(doc);
    const model = req.body?.model || "gpt-4o-mini";
    const url = `${doc.baseURL}/chat/completions`;
    const upstream = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply: ok" }], max_tokens: 16 }),
    });
    const data = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      return res.json({ ok: false, message: `upstream ${upstream.status}: ${data?.error?.message || ""}` });
    }
    const reply = data?.choices?.[0]?.message?.content || "";
    res.json({ ok: true, model, sample: reply.slice(0, 60) });
  } catch (e) {
    res.json({ ok: false, message: String(e.message || e) });
  }
});

// ── model registry ──
router.get("/models", async (req, res) => {
  // eslint-disable-next-line no-unused-vars
  let models = pricing.listModels().map(({ _id, __v, ...m }) => ({
    ...m,
    toolCallSupported: supportsTools(m.provider, m.id),
  }));
  if (req.query.live === "true") {
    const { eff } = await getRouter();
    const liveIds = new Set(eff?.liveIds || []);
    models = models.filter((m) => liveIds.has(m.provider));
  }
  res.json(models);
});

// Live test — send a user message to a specific model and return the response.
router.post("/models/:id/test", async (req, res) => {
  try {
    const model = pricing.getModel(req.params.id);
    if (!model) return res.status(404).json({ ok: false, message: "model not found" });
    const eff = await connections.effective();
    const p = eff.providers[model.provider];
    if (!p) return res.status(400).json({ ok: false, message: `provider "${model.provider}" is not configured` });
    const message = String(req.body?.message || "Reply with exactly: ok").slice(0, 1000);
    const start = Date.now();
    const cfg = { ...toRouterConfig(model.provider, p), model: model.id };
    const r = createRouter({ providers: { [model.provider]: cfg }, defaultProvider: model.provider });
    const out = await r.complete({ messages: [{ role: "user", content: message }], maxTokens: 512 });
    res.json({
      ok: true,
      text: out.text || "",
      model: out.modelId || model.id,
      provider: model.provider,
      latencyMs: Date.now() - start,
      usage: out.usage || null,
    });
  } catch (e) {
    res.json({ ok: false, message: String(e.message || e) });
  }
});

router.post("/models", async (req, res, next) => {
  try {
    const { id, provider, label, inputPer1M, outputPer1M, tier } = req.body || {};
    if (!id || !String(id).trim()) return res.status(400).json({ error: "id is required" });
    if (!provider || !String(provider).trim()) return res.status(400).json({ error: "provider is required" });
    if (!["light", "mid", "premium"].includes(tier)) return res.status(400).json({ error: "tier must be light, mid, or premium" });
    if (!(Number(inputPer1M) >= 0) || !(Number(outputPer1M) >= 0)) return res.status(400).json({ error: "prices must be non-negative numbers" });
    const { bestUsedFor, releaseDate, contextWindow } = req.body || {};
    const doc = await ModelEntry.create({
      id: String(id).trim(),
      provider: String(provider).trim(),
      label: label ? String(label).trim() : "",
      inputPer1M: Number(inputPer1M),
      outputPer1M: Number(outputPer1M),
      tier,
      builtIn: false,
      enabled: true,
      bestUsedFor: bestUsedFor ? String(bestUsedFor).trim() : "",
      releaseDate:  releaseDate  ? String(releaseDate).trim()  : "",
      contextWindow: contextWindow ? Number(contextWindow) : null,
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
    if (req.body.bestUsedFor != null) update.bestUsedFor = String(req.body.bestUsedFor).trim();
    if (req.body.releaseDate != null) update.releaseDate = String(req.body.releaseDate).trim();
    if (req.body.contextWindow != null) update.contextWindow = Number(req.body.contextWindow) || null;
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
  user: analytics.byUser,
};
router.get("/analytics/by/:dimension", async (req, res, next) => {
  try {
    const fn = VIEWS[req.params.dimension];
    if (!fn) return res.status(404).json({ error: "unknown dimension" });
    res.json(await fn(req.query));
  } catch (e) { next(e); }
});

router.get("/analytics/realised-savings", async (req, res, next) => {
  try { res.json(await analytics.realisedSavings(req.query)); } catch (e) { next(e); }
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
    setImmediate(() => logAction("rule.create", "rule", rule._id, { condition: rule.condition, target, enabled: !!enabled }));
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
    setImmediate(() => logAction("rule.update", "rule", req.params.id, update));
    res.json(rule);
  } catch (e) { next(e); }
});

router.delete("/rules/:id", async (req, res, next) => {
  try {
    await Rule.findByIdAndDelete(req.params.id);
    ruleEngine.invalidate();
    setImmediate(() => logAction("rule.delete", "rule", req.params.id, null));
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
  try {
    const s = await Settings.get();
    const storedVer = s.aiPolicy?.capabilityVersion ?? null;
    // Auto-regen when: assignments already exist (not a fresh install) AND version is stale.
    if (storedVer !== aiPolicy.CAPABILITY_VERSION && s.aiPolicy?.assignments) {
      const { router: r, eff } = await getRouter().catch(() => ({}));
      if (r) await aiPolicy.regenerate({ router: r, eff });
    }
    res.json(await aiPolicy.describe());
  } catch (e) { next(e); }
});

router.put("/ai-policy", async (req, res, next) => {
  try {
    await aiPolicy.setAssignments(req.body?.assignments || {});
    res.json(await aiPolicy.describe());
  } catch (e) { res.status(400).json({ error: "bad_request", message: String(e.message || e) }); }
});

router.post("/ai-policy/regenerate", async (req, res, next) => {
  try {
    const { router: r, eff } = await getRouter();
    if (!r) return res.status(503).json({ error: "demo_mode", message: "Add a provider key to generate an AI policy." });
    const goal = String(req.body?.goal || "balanced");
    const pol = await aiPolicy.regenerate({ router: r, eff, goal });
    const simulation = await aiPolicy.simulate({ assignments: pol.assignments, windowDays: Number(req.body?.windowDays) || 14 });
    res.json({ ...(await aiPolicy.describe()), simulation });
  } catch (e) { res.status(400).json({ error: "bad_request", message: String(e.message || e) }); }
});

// Project a proposed policy's cost + capability over recent global traffic (no persist).
router.post("/ai-policy/simulate", async (req, res, next) => {
  try {
    const simulation = await aiPolicy.simulate({
      assignments: req.body?.assignments || {},
      windowDays: Number(req.body?.windowDays) || 14,
    });
    res.json(simulation);
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

// ── LiveBench benchmark score sync ───────────────────────────────────────────
router.post("/livebench/sync", async (_req, res, next) => {
  try {
    const result = await require("../livebench/sync").run();
    await pricing.reload();
    aiPolicy.invalidate();
    res.json(result);
  } catch (e) { next(e); }
});

router.get("/livebench/status", async (_req, res, next) => {
  try {
    const s = await Settings.get();
    res.json({ syncedAt: s.livebenchSyncedAt || null, version: s.livebenchVersion || null });
  } catch (e) { next(e); }
});

// ── LMSYS Arena Elo sync ─────────────────────────────────────────────────────
router.post("/lmsys/sync", async (_req, res, next) => {
  try {
    const result = await require("../lmsys/sync").run();
    await pricing.reload();
    aiPolicy.invalidate();
    res.json(result);
  } catch (e) { next(e); }
});

router.get("/lmsys/status", async (_req, res, next) => {
  try {
    const s = await Settings.get();
    res.json({ syncedAt: s.lmsysSyncedAt || null, version: s.lmsysVersion || null });
  } catch (e) { next(e); }
});

// ── LiteLLM pricing/spec sync ────────────────────────────────────────────────
router.post("/litellm/sync", async (_req, res, next) => {
  try {
    const result = await require("../litellm/sync").run();
    await pricing.reload();
    res.json(result);
  } catch (e) { next(e); }
});

router.get("/litellm/status", async (_req, res, next) => {
  try {
    const s = await Settings.get();
    res.json({ syncedAt: s.litellmSyncedAt || null, version: s.litellmVersion || null });
  } catch (e) { next(e); }
});

// ── Consolidated benchmark + pricing sync (single-button flow) ────────────────
router.post("/benchmarks/sync", async (_req, res, next) => {
  try {
    // LiteLLM (pricing) runs first — no ordering dependency
    const lt = await require("../litellm/sync").run().catch((e) => ({ error: e.message }));
    // LiveBench then LMSYS sequentially — LMSYS skips models LiveBench already covered
    const lb = await require("../livebench/sync").run().catch((e) => ({ error: e.message }));
    const ls = await require("../lmsys/sync").run().catch((e) => ({ error: e.message }));
    await pricing.reload();
    aiPolicy.invalidate();
    res.json({ litellm: lt, livebench: lb, lmsys: ls });
  } catch (e) { next(e); }
});

router.get("/benchmarks/status", async (_req, res, next) => {
  try {
    const s = await Settings.get();
    const dates = [s.livebenchSyncedAt, s.lmsysSyncedAt, s.litellmSyncedAt].filter(Boolean);
    const lastSyncedAt = dates.length ? new Date(Math.max(...dates.map((d) => new Date(d)))) : null;
    res.json({
      lastSyncedAt,
      livebench: { syncedAt: s.livebenchSyncedAt || null, version: s.livebenchVersion || null },
      lmsys:     { syncedAt: s.lmsysSyncedAt     || null, version: s.lmsysVersion     || null },
      litellm:   { syncedAt: s.litellmSyncedAt   || null, version: s.litellmVersion   || null },
    });
  } catch (e) { next(e); }
});

// ── Governance settings (maintenance mode, max-tokens, webhook, retention, PII) ──
const GOVERNANCE_FIELDS = ["maintenanceMode", "maxTokensGuardrail", "webhookUrl", "retentionDays", "piiMaskingEnabled"];

router.get("/governance", async (_req, res, next) => {
  try {
    const s = await Settings.get();
    res.json({
      maintenanceMode: s.maintenanceMode || { enabled: false, message: "" },
      maxTokensGuardrail: s.maxTokensGuardrail || null,
      webhookUrl: s.webhookUrl || null,
      retentionDays: s.retentionDays ?? 90,
      piiMaskingEnabled: s.piiMaskingEnabled ?? false,
    });
  } catch (e) { next(e); }
});

router.patch("/governance", async (req, res, next) => {
  try {
    const body = req.body || {};
    const update = {};
    if (body.maintenanceMode !== undefined) {
      update["maintenanceMode.enabled"] = !!body.maintenanceMode.enabled;
      if (typeof body.maintenanceMode.message === "string") {
        update["maintenanceMode.message"] = body.maintenanceMode.message.trim() || "Service temporarily unavailable.";
      }
    }
    if ("maxTokensGuardrail" in body) {
      update.maxTokensGuardrail = body.maxTokensGuardrail ? Math.max(1, Number(body.maxTokensGuardrail)) : null;
    }
    if ("webhookUrl" in body) update.webhookUrl = body.webhookUrl ? String(body.webhookUrl).trim() : null;
    if ("retentionDays" in body) update.retentionDays = Math.max(0, Number(body.retentionDays) || 0) || null;
    if ("piiMaskingEnabled" in body) update.piiMaskingEnabled = !!body.piiMaskingEnabled;

    await Settings.updateOne({ key: "global" }, { $set: update }, { upsert: true });
    const s = await Settings.get();
    setImmediate(() => logAction("governance.update", "settings", "global", body));
    res.json({
      maintenanceMode: s.maintenanceMode || { enabled: false, message: "" },
      maxTokensGuardrail: s.maxTokensGuardrail || null,
      webhookUrl: s.webhookUrl || null,
      retentionDays: s.retentionDays ?? 90,
      piiMaskingEnabled: s.piiMaskingEnabled ?? false,
    });
  } catch (e) { next(e); }
});

// ── Audit log (admin actions) ──
router.get("/audit", async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const page  = Math.max(Number(req.query.page)  || 1,  1);
    const [items, total] = await Promise.all([
      AuditLog.find().sort({ timestamp: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      AuditLog.countDocuments(),
    ]);
    res.json({ items, total, page, limit });
  } catch (e) { next(e); }
});

// ── Provider health (error rate + avg latency over last 24h) ──
router.get("/analytics/provider-health", async (_req, res, next) => {
  try { res.json(await analytics.providerHealth()); } catch (e) { next(e); }
});

// ── Per-application config (kill switch, model opt-out, AI policy override) ──
const ApplicationConfig = require("../models/ApplicationConfig");

const DEFAULT_APP_CONFIG = { killSwitchEnabled: false, killSwitchMessage: null, modelOptOut: [], aiPolicyAssignments: null };

router.get("/app-configs", async (_req, res, next) => {
  try {
    const configs = await ApplicationConfig.find().lean();
    res.json(configs);
  } catch (e) { next(e); }
});

router.get("/app-configs/:app", async (req, res, next) => {
  try {
    const cfg = await ApplicationConfig.findOne({ applicationName: req.params.app }).lean();
    res.json(cfg ? cfg : { applicationName: req.params.app, ...DEFAULT_APP_CONFIG });
  } catch (e) { next(e); }
});

router.put("/app-configs/:app", async (req, res, next) => {
  try {
    const { killSwitchEnabled, killSwitchMessage, modelOptOut, aiPolicyAssignments } = req.body || {};
    const update = {};
    if (typeof killSwitchEnabled === "boolean") update.killSwitchEnabled = killSwitchEnabled;
    if ("killSwitchMessage" in req.body) update.killSwitchMessage = killSwitchMessage ? String(killSwitchMessage).trim() : null;
    if (Array.isArray(modelOptOut)) update.modelOptOut = modelOptOut.filter(Boolean);
    if ("aiPolicyAssignments" in req.body) update.aiPolicyAssignments = aiPolicyAssignments || null;
    const cfg = await ApplicationConfig.findOneAndUpdate(
      { applicationName: req.params.app },
      { $set: update },
      { new: true, upsert: true }
    ).lean();
    setImmediate(() => logAction("appConfig.update", "appConfig", req.params.app, update));
    res.json(cfg);
  } catch (e) { next(e); }
});

router.post("/app-configs/:app/generate-policy", async (req, res, next) => {
  try {
    const { router: r, eff } = await getRouter();
    if (!r) return res.status(503).json({ error: "no live providers — cannot generate policy" });
    const excludeModels = Array.isArray(req.body?.excludeModels) ? req.body.excludeModels : [];
    const goal = String(req.body?.goal || "balanced");
    const { assignments, generatorModel } = await aiPolicy.computeAssignments({ router: r, eff, excludeModels, goal });
    const generatedAt = new Date();
    const cfg = await ApplicationConfig.findOneAndUpdate(
      { applicationName: req.params.app },
      { $set: { aiPolicyAssignments: assignments } },
      { new: true, upsert: true }
    ).lean();
    setImmediate(() => logAction("appConfig.generatePolicy", "appConfig", req.params.app, { excludeModels, goal }));
    const simulation = await aiPolicy.simulate({ assignments, application: req.params.app, windowDays: Number(req.body?.windowDays) || 14 });
    res.json({ assignments, generatedAt, generatorModel: generatorModel.id, cfg, simulation });
  } catch (e) { next(e); }
});

// Project a proposed policy's cost + capability over this app's recent traffic (no persist).
router.post("/app-configs/:app/simulate", async (req, res, next) => {
  try {
    const simulation = await aiPolicy.simulate({
      assignments: req.body?.assignments || {},
      application: req.params.app,
      windowDays: Number(req.body?.windowDays) || 14,
    });
    res.json(simulation);
  } catch (e) { next(e); }
});

router.post("/app-configs/:app/set-default-policy", async (req, res, next) => {
  try {
    const cfg = await ApplicationConfig.findOne({ applicationName: req.params.app }).lean();
    if (!cfg?.aiPolicyAssignments) return res.status(400).json({ error: "No custom policy set for this application." });
    await Settings.updateOne({ key: "global" }, { $set: { aiPolicy: cfg.aiPolicyAssignments } }, { upsert: true });
    aiPolicy.invalidate?.();
    setImmediate(() => logAction("appConfig.setDefaultPolicy", "settings", "global", { from: req.params.app }));
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
