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
const EvalCampaign = require("../models/EvalCampaign");
const EvalPair = require("../models/EvalPair");
const EvalDataset = require("../models/EvalDataset");
const EvalItem = require("../models/EvalItem");
const EvalRun = require("../models/EvalRun");
const EvalResult = require("../models/EvalResult");
const { invalidateCampaignCache } = require("../eval/shadow");
const { summarizeEvalPairs } = require("../eval/logic");
const evalDatasetBuilder = require("../eval/dataset");
const evalReplay = require("../eval/replay");
const evalThresholds = require("../eval/thresholds");
const { sameFamily } = require("../eval/rubricJudge");
const { tierForTask } = require("../classify/classifier");
const RoutingExperiment = require("../models/RoutingExperiment");
const canaryEngine = require("../routing/canaryEngine");
const secrets = require("../security/secrets");
const { config, KNOWN_PROVIDERS } = require("../config");
const { classifyModelImport, isChatLikelyModelId } = require("../providers/importLogic");
const { csvCell } = require("../utils/csv");

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

router.get("/about", async (_req, res, next) => {
  try {
    // package.json is at the repo root (server/src/api → ../../../). Guarded so a missing file
    // degrades to "unknown version" instead of 500-ing /about (which ops/deploy.sh reads for the
    // model-seed version).
    let pkg = {};
    try { pkg = require("../../../package.json"); } catch { /* version unknown */ }
    const s = await Settings.get().catch(() => null);
    res.json({
      version: pkg.version,
      name: pkg.name,
      sdkJs: "0.2.0",
      sdkPython: "0.2.0",
      nodeVersion: process.version,
      modelSeedVersion: s?.modelSeedVersion ?? null, // ops/deploy.sh uses this to detect a re-seed
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
    const { dimension, value, period, limit, action, warningThreshold } = req.body || {};
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
      warningThreshold: warningThreshold != null ? Math.min(1, Math.max(0, Number(warningThreshold))) : 0.8,
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
    if (req.body.warningThreshold != null) update.warningThreshold = Math.min(1, Math.max(0, Number(req.body.warningThreshold)));
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
      // A 404 here almost always means the tested MODEL isn't served (auth/endpoint are fine),
      // not that the connection is broken — say so, since the tested model may be arbitrary.
      const hint = upstream.status === 404
        ? ` — model "${model}" not found on this provider (connection/auth look OK; try a chat model this provider hosts)`
        : `: ${data?.error?.message || ""}`;
      return res.json({ ok: false, model, message: `upstream ${upstream.status}${hint}` });
    }
    const reply = data?.choices?.[0]?.message?.content || "";
    res.json({ ok: true, model, sample: reply.slice(0, 60) });
  } catch (e) {
    res.json({ ok: false, message: String(e.message || e) });
  }
});

// Discover a custom provider's models via its OpenAI-compatible GET /v1/models endpoint.
// Annotates each with whether it's already known in the registry (so the UI can enrich pricing).
router.get("/custom-providers/:id/models", async (req, res) => {
  try {
    const doc = await CustomProvider.findOne({ id: req.params.id }).lean();
    if (!doc) return res.status(404).json({ ok: false, message: "provider not found" });
    const apiKey = secrets.decrypt(doc);
    const upstream = await fetch(`${doc.baseURL}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const data = await upstream.json().catch(() => null);
    if (!upstream.ok) return res.json({ ok: false, message: `upstream ${upstream.status}: ${data?.error?.message || ""}` });
    const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
    const models = list.map((m) => (typeof m === "string" ? m : m?.id)).filter(Boolean).map((id) => {
      const known = pricing.getModel(id);
      return { id, known: !!known, registered: !!known && known.provider === doc.id, chatLikely: isChatLikelyModelId(id) };
    });
    res.json({ ok: true, models });
  } catch (e) {
    res.json({ ok: false, message: String(e.message || e) });
  }
});

// Bulk-register selected discovered models under a custom provider. Adopts orphaned synced rows
// (re-points their provider) and enriches from the existing catalog; unmatched → $0 pricing row.
router.post("/custom-providers/:id/models", async (req, res, next) => {
  try {
    const doc = await CustomProvider.findOne({ id: req.params.id }).lean();
    if (!doc) return res.status(404).json({ error: "not_found" });
    const ids = Array.isArray(req.body?.models) ? req.body.models.filter((x) => typeof x === "string" && x.trim()) : [];
    if (!ids.length) return res.status(400).json({ error: "models must be a non-empty array of ids" });

    // Providers we must not hijack: built-in known providers + other live custom providers.
    const otherCustom = await CustomProvider.find({ enabled: true }, { id: 1 }).lean();
    const connectable = new Set([...KNOWN_PROVIDERS, ...otherCustom.map((c) => c.id).filter((cid) => cid !== doc.id)]);

    const result = { created: 0, adopted: 0, skipped: 0, conflicts: [] };
    for (const id of ids) {
      const existing = await ModelEntry.findOne({ id }).lean();
      const action = classifyModelImport(existing, doc.id, connectable);
      if (action === "create") {
        await ModelEntry.create({
          id, provider: doc.id, label: id, tier: "mid",
          inputPer1M: 0, outputPer1M: 0, builtIn: false, enabled: true,
        });
        result.created++;
      } else if (action === "adopt") {
        await ModelEntry.updateOne({ id }, { $set: { provider: doc.id, enabled: true } });
        result.adopted++;
      } else if (action === "conflict") {
        result.conflicts.push(id);
      } else {
        result.skipped++;
      }
    }
    await pricing.reload();
    setImmediate(() => logAction("customProvider.importModels", "customProvider", doc.id, { count: ids.length, created: result.created, adopted: result.adopted }));
    res.json(result);
  } catch (e) { next(e); }
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
  // routable=true → only chat-capable models (drops media/embedding models like Lyria that
  // can't serve /chat/completions). Used by the routing UI and judge/target pickers.
  if (req.query.routable === "true") {
    models = models.filter((m) => m.chatCapable !== false);
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

router.get("/analytics/timeseries", async (req, res, next) => {
  try {
    const bucket = req.query.bucket === "hour" ? "hour" : "day";
    res.json(await analytics.timeseries(req.query, bucket));
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
      // Exclude the heavy captured-context fields from the list — the drilldown fetches them by id.
      RequestRecord.find(match).select("-messages -responseText").sort({ timestamp: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      RequestRecord.countDocuments(match),
    ]);
    res.json({ items, total, page, limit });
  } catch (e) { next(e); }
});

// CSV export — same filters as /requests but no pagination; streams all matching rows.
router.get("/requests/export", async (req, res, next) => {
  try {
    const match = analytics.buildMatch(req.query);
    const COLS = [
      "timestamp", "requestId", "application", "workflow", "department", "userId",
      "taskType", "model", "modelRequested", "provider", "routingDecision", "classifiedBy",
      "promptTokens", "completionTokens", "totalTokens", "totalCost",
      "latencyMs", "status", "cacheHit", "difficulty", "difficultyScore",
    ];
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="requests.csv"');
    res.write(COLS.join(",") + "\n");
    const cursor = RequestRecord.find(match).select(COLS.join(" ")).sort({ timestamp: -1 }).lean().cursor();
    for await (const doc of cursor) {
      res.write(COLS.map((c) => csvCell(doc[c])).join(",") + "\n");
    }
    res.end();
  } catch (e) { next(e); }
});

// Full single record incl. captured payload + response (for the request drilldown).
router.get("/requests/:id", async (req, res, next) => {
  try {
    const doc = await RequestRecord.findOne({ requestId: req.params.id }).lean();
    if (!doc) return res.status(404).json({ error: "not found" });
    res.json(doc);
  } catch (e) { next(e); }
});

// ── recommendations ──
router.get("/recommendations", async (req, res, next) => {
  try {
    const q = req.query.status ? { status: req.query.status } : {};
    res.json(await Recommendation.find(q).sort({ projectedSavings: -1 }).lean());
  } catch (e) { next(e); }
});

// Explains the recommendation landscape (powers the self-diagnosing empty state): what was
// analyzed, and the high-spend task types excluded only because they aren't marked cheap.
router.get("/recommendations/analysis", async (_req, res, next) => {
  try { res.json(await recommender.analyze()); } catch (e) { next(e); }
});

router.post("/recommendations/recompute", async (_req, res, next) => {
  try { res.json(await recommender.recompute()); } catch (e) { next(e); }
});

// Accept → create a disabled rule from the recommendation, mark accepted.
// GATE (P0 eval-backed routing): a recommendation may only become a rule once it has PASSED an
// offline eval, or the caller supplies an override { reason, approver, expiresAt? }. This is the
// core promise — no cost-saving rule ships on price math alone. Pass ?dryRun=1 to check the gate.
router.post("/recommendations/:id/accept", async (req, res, next) => {
  try {
    const rec = await Recommendation.findById(req.params.id);
    if (!rec) return res.status(404).json({ error: "not found" });

    const override = (req.body && req.body.override) || null;
    const gate = evalThresholds.gateAccept(rec, override);
    if (!gate.allowed) {
      return res.status(409).json({ error: "eval_required", message: gate.reason, evalStatus: rec.evalStatus });
    }
    if (gate.status === "overridden") {
      rec.evalStatus = "overridden";
      rec.override = { reason: override.reason, approver: override.approver, at: new Date(), expiresAt: override.expiresAt || null };
    }

    // Rule scope is explicit, not silently global: use the caller-provided scope, else the
    // recommendation's own scope. Both default to null (any) only when nothing is set, and the
    // resolved condition is returned + audited so a broad rule is never a surprise.
    const scope = (req.body && req.body.scope) || {};
    const condition = {
      taskType: rec.taskType,
      application: scope.application ?? rec.application ?? null,
      workflow: scope.workflow ?? rec.workflow ?? null,
    };
    const rule = await Rule.create({
      condition,
      target: { provider: rec.suggestedProvider, model: rec.suggestedModel },
      enabled: false, // human must explicitly switch it on
      createdBy: "console",
      sourceRecommendation: rec._id,
      note: rec.title,
    });
    rec.status = "accepted";
    await rec.save();
    ruleEngine.invalidate();
    setImmediate(() => logAction("recommendation.accept", "recommendation", String(rec._id), {
      via: gate.status, ruleId: String(rule._id), candidateModel: rec.suggestedModel, evalRunId: rec.evalRunId ? String(rec.evalRunId) : null,
    }));
    res.json({ recommendation: rec, rule, acceptedVia: gate.status });
  } catch (e) { next(e); }
});

// Build an immutable eval dataset from historical traffic for this recommendation's scope.
router.post("/recommendations/:id/create-eval-dataset", async (req, res, next) => {
  try {
    const rec = await Recommendation.findById(req.params.id);
    if (!rec) return res.status(404).json({ error: "not found" });
    const { targetCount, piiMode, windowDays } = req.body || {};
    const dataset = await evalDatasetBuilder.createFromTraffic({ rec, targetCount, piiMode, windowDays });
    if (dataset.status === "ready") {
      rec.evalDatasetId = dataset._id;
      if (rec.evalStatus === "not_started") rec.evalStatus = "dataset_ready";
      await rec.save();
    }
    setImmediate(() => logAction("eval.dataset.create", "evalDataset", String(dataset._id), { recommendationId: String(rec._id), itemCount: dataset.itemCount, status: dataset.status }));
    if (dataset.status === "failed") {
      // Surface the reason as `message` so the UI shows *why*, not a bare "422".
      const body = dataset.toObject ? dataset.toObject() : dataset;
      return res.status(422).json({ ...body, error: "no_replayable_traffic", message: dataset.error });
    }
    res.json(dataset);
  } catch (e) { next(e); }
});

// Start an offline eval run for this recommendation (uses its latest ready dataset, or a given datasetId).
router.post("/recommendations/:id/run-eval", async (req, res, next) => {
  try {
    const rec = await Recommendation.findById(req.params.id);
    if (!rec) return res.status(404).json({ error: "not found" });
    const { datasetId, judgeModel, maxRunCostUsd } = req.body || {};

    const dataset = datasetId
      ? await EvalDataset.findById(datasetId)
      : await EvalDataset.findOne({ recommendationId: rec._id, status: "ready" }).sort({ createdAt: -1 });
    if (!dataset || dataset.status !== "ready") {
      return res.status(409).json({ error: "no_dataset", message: "Create a ready eval dataset first (POST .../create-eval-dataset)." });
    }
    if (dataset.piiMode === "metadata_only") {
      return res.status(422).json({ error: "not_replayable", message: "A metadata_only dataset has no prompts to replay. Use a masked dataset." });
    }
    // same-family judge guard on high-risk tasks (self-preference bias).
    if (dataset.riskTier === "high" && judgeModel && sameFamily(judgeModel, dataset.candidateModel)) {
      return res.status(422).json({ error: "judge_same_family", message: "For high-risk tasks the judge must not be from the candidate's model family." });
    }

    const risk = evalThresholds.riskForTier(tierForTask(rec.taskType));
    const thresholds = evalThresholds.defaultThresholds(risk);
    const run = await evalReplay.startRun({ rec, dataset, judgeModel: judgeModel || null, thresholds, maxRunCostUsd: maxRunCostUsd ?? null });
    setImmediate(() => logAction("eval.run.start", "evalRun", String(run._id), { recommendationId: String(rec._id), candidateModel: dataset.candidateModel, judgeModel: judgeModel || null }));
    res.status(run.status === "failed" ? 422 : 202).json(run);
  } catch (e) { next(e); }
});

// Record a manual override reason on a recommendation (audited). Does not create the rule;
// the subsequent accept call carries the override, or reads this one.
router.post("/recommendations/:id/override", async (req, res, next) => {
  try {
    const { reason, approver, expiresAt } = req.body || {};
    if (!reason || !approver) return res.status(400).json({ error: "reason and approver are required" });
    const rec = await Recommendation.findById(req.params.id);
    if (!rec) return res.status(404).json({ error: "not found" });
    rec.override = { reason, approver, at: new Date(), expiresAt: expiresAt || null };
    rec.evalStatus = "overridden";
    await rec.save();
    setImmediate(() => logAction("eval.override", "recommendation", String(rec._id), { approver, reason }));
    res.json(rec);
  } catch (e) { next(e); }
});

// Create an eval directly (not from a recommendation): build a dataset from an application's
// recent single-shot traffic and start an offline run comparing a candidate model against the
// baseline. Lets users test ANY candidate, recommended or not. Mirrors the recommendation
// create-dataset + run-eval flow in one call, reusing the same builder/runner with a
// recommendation-shaped scope (recommendationId stays null).
router.post("/evals", async (req, res, next) => {
  try {
    const { application, taskType, baselineModel, candidateModel, judgeModel, targetCount, piiMode, windowDays, maxRunCostUsd } = req.body || {};
    if (!application) return res.status(400).json({ error: "application is required" });
    if (!baselineModel) return res.status(400).json({ error: "baselineModel is required" });
    if (!candidateModel) return res.status(400).json({ error: "candidateModel is required" });
    if (baselineModel === candidateModel) return res.status(400).json({ error: "baselineModel and candidateModel must differ" });

    // Scope shaped like a recommendation so the existing builder/runner work unchanged.
    const scope = { _id: null, application, taskType: taskType || null, currentModel: baselineModel, suggestedModel: candidateModel };
    const dataset = await evalDatasetBuilder.createFromTraffic({ rec: scope, targetCount, piiMode, windowDays });
    if (dataset.status !== "ready") {
      const body = dataset.toObject ? dataset.toObject() : dataset;
      return res.status(422).json({ ...body, error: "no_replayable_traffic", message: dataset.error });
    }
    if (dataset.riskTier === "high" && judgeModel && sameFamily(judgeModel, candidateModel)) {
      return res.status(422).json({ error: "judge_same_family", message: "For high-risk tasks the judge must not be from the candidate's model family." });
    }

    const risk = evalThresholds.riskForTier(tierForTask(taskType));
    const thresholds = evalThresholds.defaultThresholds(risk);
    const run = await evalReplay.startRun({ rec: null, dataset, judgeModel: judgeModel || null, thresholds, maxRunCostUsd: maxRunCostUsd ?? null });
    setImmediate(() => logAction("eval.create", "evalRun", String(run._id), { application, baselineModel, candidateModel, judgeModel: judgeModel || null }));
    res.status(run.status === "failed" ? 422 : 201).json({ dataset, run });
  } catch (e) { next(e); }
});

// ── Eval datasets / runs (read views) ─────────────────────────────────────────
router.get("/evals/datasets", async (req, res, next) => {
  try {
    const q = req.query.recommendationId ? { recommendationId: req.query.recommendationId } : {};
    res.json(await EvalDataset.find(q).sort({ createdAt: -1 }).lean());
  } catch (e) { next(e); }
});
router.get("/evals/datasets/:id", async (req, res, next) => {
  try {
    const ds = await EvalDataset.findById(req.params.id).lean().catch(() => null);
    if (!ds) return res.status(404).json({ error: "not found" });
    res.json({ ...ds, sampleItems: await EvalItem.find({ datasetId: ds._id }).limit(10).lean() });
  } catch (e) { next(e); }
});
router.get("/evals/runs", async (req, res, next) => {
  try {
    const q = req.query.recommendationId ? { recommendationId: req.query.recommendationId } : {};
    res.json(await EvalRun.find(q).sort({ createdAt: -1 }).lean());
  } catch (e) { next(e); }
});
router.get("/evals/runs/:id", async (req, res, next) => {
  try {
    const run = await EvalRun.findById(req.params.id).lean().catch(() => null);
    if (!run) return res.status(404).json({ error: "not found" });
    res.json(run);
  } catch (e) { next(e); }
});
// Cancel a queued/running run; the worker stops it at the next checkpoint (queued stops immediately).
router.post("/evals/runs/:id/cancel", async (req, res, next) => {
  try {
    const run = await EvalRun.findOneAndUpdate(
      { _id: req.params.id, status: { $in: ["queued", "running"] } },
      { $set: { status: "cancelled" } }, { new: true }
    ).lean().catch(() => null);
    if (!run) return res.status(409).json({ error: "not_cancellable", message: "run is not queued or running" });
    setImmediate(() => logAction("eval.run.cancel", "evalRun", req.params.id, null));
    res.json(run);
  } catch (e) { next(e); }
});
// Worst candidate examples first (worse verdicts + critical failures), for the evidence view.
router.get("/evals/runs/:id/results", async (req, res, next) => {
  try {
    const order = { worse: 0, equal: 1, better: 2 };
    const results = await EvalResult.find({ evalRunId: req.params.id }).lean();
    results.sort((a, b) =>
      (b.criticalFailure - a.criticalFailure) ||
      ((order[a.judgeVerdict] ?? 3) - (order[b.judgeVerdict] ?? 3)));
    res.json(results);
  } catch (e) { next(e); }
});

// Clamp/normalize canary guardrail inputs to sane numbers (falls back to defaults).
function sanitizeGuardrails(g) {
  const d = { maxErrorRateIncrease: 0.02, maxLatencyRegressionPct: 0.25, maxWorseRate: 0.10, minCostSavingPct: 0.10 };
  if (!g || typeof g !== "object") return d;
  const num = (v, def) => (v != null && !isNaN(Number(v)) ? Number(v) : def);
  return {
    maxErrorRateIncrease: num(g.maxErrorRateIncrease, d.maxErrorRateIncrease),
    maxLatencyRegressionPct: num(g.maxLatencyRegressionPct, d.maxLatencyRegressionPct),
    maxWorseRate: num(g.maxWorseRate, d.maxWorseRate),
    minCostSavingPct: num(g.minCostSavingPct, d.minCostSavingPct),
  };
}

// ── Routing experiments (canary rollout, Phase 3) ─────────────────────────────
router.get("/routing-experiments", async (req, res, next) => {
  try {
    const q = req.query.status ? { status: req.query.status } : {};
    res.json(await RoutingExperiment.find(q).sort({ createdAt: -1 }).lean());
  } catch (e) { next(e); }
});
router.get("/routing-experiments/:id", async (req, res, next) => {
  try {
    const exp = await RoutingExperiment.findById(req.params.id).lean().catch(() => null);
    if (!exp) return res.status(404).json({ error: "not found" });
    res.json(exp);
  } catch (e) { next(e); }
});

// Create a canary from a passed recommendation (only auto-routed traffic is affected).
router.post("/recommendations/:id/create-canary", async (req, res, next) => {
  try {
    const rec = await Recommendation.findById(req.params.id);
    if (!rec) return res.status(404).json({ error: "not found" });
    const b = req.body || {};
    const offlineRun = rec.evalRunId ? await EvalRun.findById(rec.evalRunId).lean().catch(() => null) : null;
    const gate = evalThresholds.canActivateShadow(offlineRun, b.override); // same "passed offline or override" bar
    if (!gate.allowed) return res.status(409).json({ error: "eval_required", message: gate.reason });

    const exp = await RoutingExperiment.create({
      evalRunId: rec.evalRunId || null, recommendationId: rec._id, shadowCampaignId: rec.shadowCampaignId || null,
      scope: { application: b.application || rec.application || null, workflow: b.workflow || null, taskType: rec.taskType || null },
      baselineModel: rec.currentModel, candidateModel: rec.suggestedModel,
      candidateProvider: rec.suggestedProvider || pricing.getModel(rec.suggestedModel)?.provider || null,
      rolloutPct: b.rolloutPct != null ? Math.min(100, Math.max(0, Number(b.rolloutPct))) : 10,
      guardrails: sanitizeGuardrails(b.guardrails),
      metricsWindowMinutes: b.metricsWindowMinutes != null ? Math.max(5, Number(b.metricsWindowMinutes)) : 60,
      status: "active", createdBy: "console", approvedBy: b.approvedBy || null,
    });
    rec.experimentId = exp._id;
    await rec.save();
    canaryEngine.invalidate();
    setImmediate(() => logAction("canary.create", "routingExperiment", String(exp._id), { recommendationId: String(rec._id), rolloutPct: exp.rolloutPct }));
    res.status(201).json(exp);
  } catch (e) { next(e); }
});

router.patch("/routing-experiments/:id", async (req, res, next) => {
  try {
    const b = req.body || {};
    const update = {};
    if (b.rolloutPct != null) update.rolloutPct = Math.min(100, Math.max(0, Number(b.rolloutPct)));
    if (b.status && ["active", "paused"].includes(b.status)) update.status = b.status; // rollback/promote have their own routes
    if (b.guardrails) update.guardrails = sanitizeGuardrails(b.guardrails);
    if (b.metricsWindowMinutes != null) update.metricsWindowMinutes = Math.max(5, Number(b.metricsWindowMinutes));
    const exp = await RoutingExperiment.findByIdAndUpdate(req.params.id, { $set: update }, { new: true }).lean();
    if (!exp) return res.status(404).json({ error: "not found" });
    canaryEngine.invalidate();
    setImmediate(() => logAction("canary.update", "routingExperiment", req.params.id, update));
    res.json(exp);
  } catch (e) { next(e); }
});

// Manual rollback — stop diverting traffic; the candidate is abandoned but logs are kept.
router.post("/routing-experiments/:id/rollback", async (req, res, next) => {
  try {
    const reason = (req.body && req.body.reason) || "manual rollback";
    const exp = await RoutingExperiment.findByIdAndUpdate(
      req.params.id, { $set: { status: "rolled_back", rollbackReason: reason } }, { new: true }
    ).lean();
    if (!exp) return res.status(404).json({ error: "not found" });
    canaryEngine.invalidate();
    setImmediate(() => logAction("canary.rollback", "routingExperiment", req.params.id, { reason }));
    res.json(exp);
  } catch (e) { next(e); }
});

// Promote — go to 100% by creating an ENABLED, reversible rule and marking the rec accepted.
router.post("/routing-experiments/:id/promote", async (req, res, next) => {
  try {
    const exp = await RoutingExperiment.findById(req.params.id);
    if (!exp) return res.status(404).json({ error: "not found" });
    if (exp.status === "rolled_back") return res.status(409).json({ error: "rolled_back", message: "cannot promote a rolled-back experiment" });
    const provider = exp.candidateProvider || pricing.getModel(exp.candidateModel)?.provider;
    if (!provider) return res.status(422).json({ error: "no_provider", message: "cannot determine the candidate's provider; set candidateProvider on the experiment." });
    const rule = await Rule.create({
      condition: { taskType: exp.scope?.taskType || null, application: exp.scope?.application || null, workflow: exp.scope?.workflow || null },
      target: { provider, model: exp.candidateModel },
      enabled: true, createdBy: "console",
      sourceRecommendation: exp.recommendationId || null,
      note: `promoted canary ${exp.baselineModel} → ${exp.candidateModel}`,
    });
    exp.status = "promoted"; exp.rolloutPct = 100; exp.ruleId = rule._id; exp.approvedBy = (req.body && req.body.approvedBy) || exp.approvedBy;
    await exp.save();
    if (exp.recommendationId) await Recommendation.findByIdAndUpdate(exp.recommendationId, { status: "accepted" });
    ruleEngine.invalidate();
    canaryEngine.invalidate();
    setImmediate(() => logAction("canary.promote", "routingExperiment", String(exp._id), { ruleId: String(rule._id), candidateModel: exp.candidateModel }));
    res.json({ experiment: exp, rule });
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
    // Merge built-in task types with any app-provided task types observed in traffic.
    const observed = (await RequestRecord.distinct("taskType")).filter(Boolean).map((x) => String(x).toLowerCase());
    const allTypes = [...new Set([...TASK_TYPES, ...observed])].sort();
    res.json({ ...d, taskTypes: allTypes });
  } catch (e) { next(e); }
});

router.put("/policy", async (req, res, next) => {
  try {
    const body = req.body || {};
    // Validate task types against built-in catalog + any task types observed in traffic.
    let cheapTaskTypes;
    if (Array.isArray(body.cheapTaskTypes)) {
      const observed = (await RequestRecord.distinct("taskType")).filter(Boolean).map((x) => String(x).toLowerCase());
      const known = new Set([...TASK_TYPES, ...observed]);
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

function governanceView(s) {
  return {
    maintenanceMode:         s.maintenanceMode || { enabled: false, message: "" },
    maxTokensGuardrail:      s.maxTokensGuardrail || null,
    globalRpmGuardrail:      s.globalRpmGuardrail || null,
    captureRequestPayloads:  s.captureRequestPayloads !== false,  // default true
    piiMaskingEnabled:       s.piiMaskingEnabled ?? false,
    customPiiPatterns:       s.customPiiPatterns || [],
    requireApiKey:           s.requireApiKey ?? false,
    webhookUrl:              s.webhookUrl || null,
    retentionDays:           s.retentionDays ?? 90,
    alertErrorRateEnabled:   s.alertErrorRateEnabled ?? false,
    alertErrorRateThreshold: s.alertErrorRateThreshold ?? 5,
    outputGuardrailsEnabled: s.outputGuardrailsEnabled ?? false,
    outputGuardrailRules:    s.outputGuardrailRules || [],
    maskPiiInResponses:      s.maskPiiInResponses ?? false,
  };
}

router.get("/governance", async (_req, res, next) => {
  try {
    res.json(governanceView(await Settings.get()));
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
    if ("maxTokensGuardrail" in body)
      update.maxTokensGuardrail = body.maxTokensGuardrail ? Math.max(1, Number(body.maxTokensGuardrail)) : null;
    if ("globalRpmGuardrail" in body)
      update.globalRpmGuardrail = body.globalRpmGuardrail ? Math.max(1, Number(body.globalRpmGuardrail)) : null;
    if ("captureRequestPayloads" in body)
      update.captureRequestPayloads = !!body.captureRequestPayloads;
    if ("piiMaskingEnabled" in body)
      update.piiMaskingEnabled = !!body.piiMaskingEnabled;
    if ("customPiiPatterns" in body && Array.isArray(body.customPiiPatterns))
      update.customPiiPatterns = body.customPiiPatterns.filter(p => p.name && p.pattern);
    if ("requireApiKey" in body)
      update.requireApiKey = !!body.requireApiKey;
    if ("webhookUrl" in body)
      update.webhookUrl = body.webhookUrl ? String(body.webhookUrl).trim() : null;
    if ("retentionDays" in body)
      update.retentionDays = Math.max(0, Number(body.retentionDays) || 0) || null;
    if ("alertErrorRateEnabled" in body)
      update.alertErrorRateEnabled = !!body.alertErrorRateEnabled;
    if ("alertErrorRateThreshold" in body)
      update.alertErrorRateThreshold = Math.min(100, Math.max(0, Number(body.alertErrorRateThreshold) || 5));
    if ("outputGuardrailsEnabled" in body)
      update.outputGuardrailsEnabled = !!body.outputGuardrailsEnabled;
    if (Array.isArray(body.outputGuardrailRules))
      update.outputGuardrailRules = body.outputGuardrailRules.filter(r => r.pattern);
    if ("maskPiiInResponses" in body)
      update.maskPiiInResponses = !!body.maskPiiInResponses;

    await Settings.updateOne({ key: "global" }, { $set: update }, { upsert: true });
    Settings.invalidateCache();
    const s = await Settings.get();
    setImmediate(() => logAction("governance.update", "settings", "global", body));
    res.json(governanceView(s));
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

// Audit CSV export — no pagination, same optional filters as /audit.
router.get("/audit/export", async (req, res, next) => {
  try {
    const { action, entity, from, to } = req.query;
    const match = {};
    if (action) match.action = action;
    if (entity) match.entity = entity;
    if (from || to) {
      match.timestamp = {};
      if (from) match.timestamp.$gte = new Date(from);
      if (to)   match.timestamp.$lte = new Date(to);
    }
    const rows = await AuditLog.find(match).sort({ timestamp: -1 }).limit(10000).lean();
    const header = "timestamp,action,entity,entityId,actor,changes\n";
    const csv = rows.map((r) => [
      new Date(r.timestamp).toISOString(),
      r.action || "",
      r.entity || "",
      r.entityId || "",
      r.actor || "admin",
      JSON.stringify(r.changes || {}).replace(/"/g, '""'),
    ].map((v) => `"${v}"`).join(",")).join("\n");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="audit-log.csv"');
    res.send(header + csv);
  } catch (e) { next(e); }
});

// ── Provider health (error rate + avg latency over last 24h) ──
router.get("/analytics/provider-health", async (_req, res, next) => {
  try { res.json(await analytics.providerHealth()); } catch (e) { next(e); }
});

router.get("/analytics/latency-percentiles", async (req, res, next) => {
  try { res.json(await analytics.latencyPercentiles(req.query)); } catch (e) { next(e); }
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
    Settings.invalidateCache();
    aiPolicy.invalidate?.();
    setImmediate(() => logAction("appConfig.setDefaultPolicy", "settings", "global", { from: req.params.app }));
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── Shadow-eval campaigns ─────────────────────────────────────────────────────
router.get("/eval/campaigns", async (req, res, next) => {
  try {
    const campaigns = await EvalCampaign.find().sort({ createdAt: -1 }).lean();
    const withCounts = await Promise.all(campaigns.map(async (c) => ({
      ...c, pairCount: await EvalPair.countDocuments({ campaignId: c._id }),
    })));
    res.json(withCounts);
  } catch (e) { next(e); }
});

router.post("/eval/campaigns", async (req, res, next) => {
  try {
    const b = req.body || {};
    const { application, candidateModel, judgeModel, sampleRate, thresholds, name, baselineModel, scope,
      requiredEvalRunId, maxDailyShadowBudgetUsd, maxCandidateErrors, startDate, endDate, override } = b;
    if (!application) return res.status(400).json({ error: "application is required" });
    if (!candidateModel) return res.status(400).json({ error: "candidateModel is required" });

    // Phase 2 gate: a campaign only goes ACTIVE if a linked offline eval passed (or overridden);
    // otherwise it is created PAUSED with the reason, ready to activate once the eval passes.
    const wantActive = b.status !== "paused";
    const offlineRun = requiredEvalRunId ? await EvalRun.findById(requiredEvalRunId).lean().catch(() => null) : null;
    const gate = evalThresholds.canActivateShadow(offlineRun, override);
    const status = wantActive && gate.allowed ? "active" : "paused";
    const statusReason = status === "paused" && wantActive ? gate.reason : null;

    const doc = await EvalCampaign.create({
      application, candidateModel, name: name || "",
      baselineModel: baselineModel || null,
      judgeModel: judgeModel || null,
      scope: { workflow: scope?.workflow || null, taskType: scope?.taskType || null },
      requiredEvalRunId: requiredEvalRunId || null,
      maxDailyShadowBudgetUsd: maxDailyShadowBudgetUsd != null ? Number(maxDailyShadowBudgetUsd) : null,
      maxCandidateErrors: maxCandidateErrors != null ? Math.max(1, Number(maxCandidateErrors)) : null,
      startDate: startDate || null, endDate: endDate || null,
      status, statusReason,
      sampleRate: sampleRate != null ? Math.min(1, Math.max(0, Number(sampleRate))) : 0.1,
      thresholds: {
        minPairs: thresholds?.minPairs != null ? Math.max(1, Number(thresholds.minPairs)) : 50,
        maxLossRate: thresholds?.maxLossRate != null ? Math.min(1, Math.max(0, Number(thresholds.maxLossRate))) : 0.1,
      },
    });
    invalidateCampaignCache();
    setImmediate(() => logAction("evalCampaign.create", "evalCampaign", String(doc._id), { application, candidateModel, status }));
    res.status(201).json(doc);
  } catch (e) { next(e); }
});

router.get("/eval/campaigns/:id", async (req, res, next) => {
  try {
    const c = await EvalCampaign.findById(req.params.id).lean().catch(() => null);
    if (!c) return res.status(404).json({ error: "not found" });
    const pairs = await EvalPair.find({ campaignId: c._id },
      { prodCost: 1, candidateCost: 1, prodLatencyMs: 1, candidateLatencyMs: 1, verdict: 1 }).lean();
    // Worst candidate examples for the evidence view (Phase 2).
    const worstExamples = await EvalPair.find({ campaignId: c._id, verdict: "worse" })
      .sort({ timestamp: -1 }).limit(20).lean();
    res.json({ ...c, summary: summarizeEvalPairs(pairs), worstExamples });
  } catch (e) { next(e); }
});

// Start a shadow campaign directly from a recommendation (requires its offline eval passed).
router.post("/recommendations/:id/start-shadow", async (req, res, next) => {
  try {
    const rec = await Recommendation.findById(req.params.id);
    if (!rec) return res.status(404).json({ error: "not found" });
    const b = req.body || {};
    const application = b.application || rec.application;
    if (!application) return res.status(400).json({ error: "application is required (recommendations are not app-scoped)" });

    const offlineRun = rec.evalRunId ? await EvalRun.findById(rec.evalRunId).lean().catch(() => null) : null;
    const gate = evalThresholds.canActivateShadow(offlineRun, b.override);
    if (!gate.allowed) return res.status(409).json({ error: "eval_required", message: gate.reason });

    const campaign = await EvalCampaign.create({
      name: `shadow: ${rec.currentModel} → ${rec.suggestedModel}`,
      application, candidateModel: rec.suggestedModel, baselineModel: rec.currentModel,
      judgeModel: b.judgeModel || null,
      scope: { taskType: rec.taskType || null, workflow: b.workflow || null },
      recommendationId: rec._id, requiredEvalRunId: rec.evalRunId || null,
      sampleRate: b.sampleRate != null ? Math.min(1, Math.max(0, Number(b.sampleRate))) : 0.1,
      maxDailyShadowBudgetUsd: b.maxDailyShadowBudgetUsd != null ? Number(b.maxDailyShadowBudgetUsd) : null,
      maxCandidateErrors: b.maxCandidateErrors != null ? Math.max(1, Number(b.maxCandidateErrors)) : null,
      startDate: b.startDate || null, endDate: b.endDate || null,
      status: "active",
    });
    rec.shadowCampaignId = campaign._id;
    await rec.save();
    invalidateCampaignCache();
    setImmediate(() => logAction("eval.shadow.start", "evalCampaign", String(campaign._id), { recommendationId: String(rec._id), via: offlineRun?.status === "passed" ? "passed" : "override" }));
    res.status(201).json(campaign);
  } catch (e) { next(e); }
});

router.get("/eval/campaigns/:id/pairs", async (req, res, next) => {
  try {
    const items = await EvalPair.find({ campaignId: req.params.id }).sort({ timestamp: -1 }).limit(50).lean();
    res.json({ items });
  } catch (e) { next(e); }
});

router.patch("/eval/campaigns/:id", async (req, res, next) => {
  try {
    const b = req.body || {};
    const existing = await EvalCampaign.findById(req.params.id).lean().catch(() => null);
    if (!existing) return res.status(404).json({ error: "not found" });

    const update = {};
    // Activating is gated on a passed offline eval (Phase 2), unless overridden.
    if (b.status && ["active", "paused", "done"].includes(b.status)) {
      if (b.status === "active" && existing.status !== "active") {
        const runId = b.requiredEvalRunId || existing.requiredEvalRunId;
        const offlineRun = runId ? await EvalRun.findById(runId).lean().catch(() => null) : null;
        const gate = evalThresholds.canActivateShadow(offlineRun, b.override);
        if (!gate.allowed) return res.status(409).json({ error: "eval_required", message: gate.reason });
        update.statusReason = null;
        update.candidateErrorCount = 0; // reset the safety counter on a fresh activation
      }
      update.status = b.status;
    }
    if (b.sampleRate != null) update.sampleRate = Math.min(1, Math.max(0, Number(b.sampleRate)));
    if (b.judgeModel !== undefined) update.judgeModel = b.judgeModel || null;
    if (b.baselineModel !== undefined) update.baselineModel = b.baselineModel || null;
    if (b.scope) update.scope = { workflow: b.scope.workflow || null, taskType: b.scope.taskType || null };
    if (b.requiredEvalRunId !== undefined) update.requiredEvalRunId = b.requiredEvalRunId || null;
    if (b.maxDailyShadowBudgetUsd !== undefined) update.maxDailyShadowBudgetUsd = b.maxDailyShadowBudgetUsd != null ? Number(b.maxDailyShadowBudgetUsd) : null;
    if (b.maxCandidateErrors !== undefined) update.maxCandidateErrors = b.maxCandidateErrors != null ? Math.max(1, Number(b.maxCandidateErrors)) : null;
    if (b.startDate !== undefined) update.startDate = b.startDate || null;
    if (b.endDate !== undefined) update.endDate = b.endDate || null;
    if (b.thresholds) update.thresholds = {
      minPairs: b.thresholds.minPairs != null ? Math.max(1, Number(b.thresholds.minPairs)) : 50,
      maxLossRate: b.thresholds.maxLossRate != null ? Math.min(1, Math.max(0, Number(b.thresholds.maxLossRate))) : 0.1,
    };
    const c = await EvalCampaign.findByIdAndUpdate(req.params.id, { $set: update }, { new: true }).lean();
    invalidateCampaignCache();
    res.json(c);
  } catch (e) { next(e); }
});

router.delete("/eval/campaigns/:id", async (req, res, next) => {
  try {
    await EvalCampaign.findByIdAndDelete(req.params.id);
    await EvalPair.deleteMany({ campaignId: req.params.id });
    invalidateCampaignCache();
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
