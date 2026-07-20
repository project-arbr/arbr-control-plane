// Admin API routes — models
const express = require("express");
const { supportsTools } = require("../../gateway/capabilities");
const connections = require("../../providers/connections");
const { createRouter } = require("../../providers/llm-router");
const { toRouterConfig, getRouter } = require("../../providers/router");
const pricing = require("../../pricing/registry");
const ModelEntry = require("../../models/ModelEntry");

const router = express.Router();

// ── model registry ──
router.get("/models", async (req, res) => {
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


module.exports = router;
