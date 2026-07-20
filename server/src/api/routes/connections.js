// Admin API routes — connections
const express = require("express");
const connections = require("../../providers/connections");
const { createRouter } = require("../../providers/llm-router");
const { toRouterConfig, getRouter } = require("../../providers/router");

const router = express.Router();

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


module.exports = router;
