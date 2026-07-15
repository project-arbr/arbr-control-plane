// Admin API routes — customProviders
const express = require("express");
const auth = require("../../gateway/auth");
const { logAction } = require("../auditLogger");
const connections = require("../../providers/connections");
const pricing = require("../../pricing/registry");
const ModelEntry = require("../../models/ModelEntry");
const CustomProvider = require("../../models/CustomProvider");
const secrets = require("../../security/secrets");
const { config, KNOWN_PROVIDERS } = require("../../config");
const { classifyModelImport, isChatLikelyModelId } = require("../../providers/importLogic");

const router = express.Router();

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


module.exports = router;
