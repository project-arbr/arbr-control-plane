// Admin API routes — connections
const express = require("express");
const connections = require("../../providers/connections");
const { requireRole } = require("../rbac");
const { createRouter } = require("../../providers/llm-router");
const { toRouterConfig, getRouter } = require("../../providers/router");
const { internalComplete } = require("../../internal/complete");
const secretResolver = require("../../security/secretResolver");
const { PROVIDERS } = require("../../config");
const { logAction } = require("../auditLogger");
const Rule = require("../../models/Rule");
const ApplicationConfig = require("../../models/ApplicationConfig");

const router = express.Router();

// ── connections (provider keys) ──
router.get("/connections", async (_req, res, next) => {
  try { res.json(await connections.statuses()); } catch (e) { next(e); }
});

// Add / replace a provider credential (stored encrypted; never echoed back).
// Body shape depends on the provider: { apiKey } or { accessKeyId, secretAccessKey, region }.
router.put("/connections/:provider", requireRole("administrator"), async (req, res, next) => {
  try {
    await connections.setCredential(req.params.provider, req.body || {});
    res.json(await connections.statuses());
  } catch (e) { res.status(400).json({ error: "bad_request", message: String(e.message || e) }); }
});

// Remove a stored credential (an env credential for the same provider still applies).
router.delete("/connections/:provider", requireRole("administrator"), async (req, res, next) => {
  try {
    await connections.removeCredential(req.params.provider);
    res.json(await connections.statuses());
  } catch (e) { next(e); }
});

// Choose the default provider used when a request names none.
router.put("/default-provider", requireRole("administrator"), async (req, res, next) => {
  try {
    await connections.setDefaultProvider(req.body?.provider || null);
    res.json(await connections.statuses());
  } catch (e) { res.status(400).json({ error: "bad_request", message: String(e.message || e) }); }
});

// Choose the default model (applies to the default provider; used in auto mode).
router.put("/default-model", requireRole("administrator"), async (req, res, next) => {
  try {
    await connections.setDefaultModel(req.body?.model || null);
    res.json(await connections.statuses());
  } catch (e) { res.status(400).json({ error: "bad_request", message: String(e.message || e) }); }
});

// ── individual provider keys (aliases) ──
//
// The four routes above are the pre-multi-key surface and keep their exact meaning:
// PUT writes the alias "default", DELETE disconnects the provider entirely. These operate
// on one key at a time.

// Add or replace one named key. Body: { alias, makeDefault?, ...credential fields }.
router.post("/connections/:provider/keys", requireRole("administrator"), async (req, res) => {
  try {
    const { alias, makeDefault, ...credential } = req.body || {};
    // Required here, unlike setCredential's default. Silently falling back to "default"
    // would let a request that forgot the name overwrite the provider's existing key.
    if (alias == null || String(alias).trim() === "") {
      return res.status(400).json({ error: "bad_request", message: "alias is required" });
    }
    await connections.setCredential(req.params.provider, credential, { alias, makeDefault: !!makeDefault });
    setImmediate(() => logAction("connection.keyAdd", "providerCredential", req.params.provider,
      { alias: String(alias || "").toLowerCase(), makeDefault: !!makeDefault }, req.user));
    res.json(await connections.statuses());
  } catch (e) { res.status(400).json({ error: "bad_request", message: String(e.message || e) }); }
});

router.put("/connections/:provider/keys/:alias", requireRole("administrator"), async (req, res) => {
  try {
    const { makeDefault, ...credential } = req.body || {};
    await connections.setCredential(req.params.provider, credential,
      { alias: req.params.alias, makeDefault: !!makeDefault });
    setImmediate(() => logAction("connection.keyUpdate", "providerCredential", req.params.provider,
      { alias: req.params.alias }, req.user));
    res.json(await connections.statuses());
  } catch (e) { res.status(400).json({ error: "bad_request", message: String(e.message || e) }); }
});

// Removing a key that a rule or an application still pins would silently redirect that
// traffic to the default key. Refuse, name what is pinning it, and make the operator opt in.
router.delete("/connections/:provider/keys/:alias", requireRole("administrator"), async (req, res, next) => {
  try {
    const { provider, alias } = req.params;
    if (req.query.force !== "1") {
      const [rules, apps] = await Promise.all([
        Rule.find({ "target.provider": provider, "target.credentialAlias": alias }).lean(),
        ApplicationConfig.find({ [`credentialAliases.${provider}`]: alias }).lean(),
      ]);
      if (rules.length || apps.length) {
        return res.status(409).json({
          error: "alias_in_use",
          message:
            `Key "${alias}" is pinned by ${rules.length} rule(s) and ${apps.length} application(s). ` +
            "They will fall back to this provider's default key if you remove it.",
          rules: rules.map((r) => ({ id: String(r._id), condition: r.condition, model: r.target?.model })),
          applications: apps.map((a) => a.applicationName),
        });
      }
    }
    await connections.removeCredential(provider, alias);
    setImmediate(() => logAction("connection.keyRemove", "providerCredential", provider,
      { alias, forced: req.query.force === "1" }, req.user));
    res.json(await connections.statuses());
  } catch (e) { res.status(400).json({ error: "bad_request", message: String(e.message || e) }); }
});

// Promote a key to the provider's default. An env credential still outranks it, so the
// response says which key is actually effective rather than implying the change took hold.
router.put("/connections/:provider/keys/:alias/default", requireRole("administrator"), async (req, res) => {
  try {
    const out = await connections.setDefaultCredential(req.params.provider, req.params.alias);
    setImmediate(() => logAction("connection.keySetDefault", "providerCredential", req.params.provider,
      { alias: out.alias, effectiveDefault: out.effectiveDefault }, req.user));
    res.json({ ...(await connections.statuses()), effectiveDefault: out.effectiveDefault });
  } catch (e) { res.status(400).json({ error: "bad_request", message: String(e.message || e) }); }
});

// Live "test" — make a tiny real call with one provider's key. ?alias= tests a specific
// key, so an operator can prove a key works BEFORE pinning traffic to it.
router.post("/connections/:provider/test", requireRole("administrator"), async (req, res) => {
  try {
    const provider = req.params.provider;
    const eff = await connections.effective();
    const p = eff.providers[provider];
    if (!p) return res.status(400).json({ ok: false, message: "provider not configured" });
    const resolved = connections.credentialFor(eff, provider, req.query.alias || null);
    if (req.query.alias && resolved.fellBack) {
      return res.json({ ok: false, message: `no key "${req.query.alias}" for provider "${provider}"` });
    }
    const r = createRouter({
      providers: { [provider]: toRouterConfig(provider, { ...p, credential: resolved.credential }) },
      defaultProvider: provider,
    });
    // Generous budget so "thinking" models (e.g. Gemini 2.5) have room to answer.
    const out = await internalComplete({
      kind: "connection-test", router: r,
      messages: [{ role: "user", content: "Reply with: ok" }], maxTokens: 256,
      context: { provider },
    });
    res.json({ ok: true, model: out.modelId, sample: (out.text || "").slice(0, 40) });
  } catch (e) {
    res.json({ ok: false, message: String(e.message || e) });
  }
});


// Re-resolve every credential-shaped env var (picks up a rotated
// secret-manager value with no restart) and invalidate the connections
// cache so the next request reflects it. Never returns a value — matches
// the statuses() masking convention exactly.
router.post("/secrets/refresh", requireRole("administrator"), async (_req, res, next) => {
  try {
    const envVarNames = ["ARBR_ADMIN_KEY", "ARBR_ENCRYPTION_KEY",
      ...Object.values(PROVIDERS).flatMap((p) => Object.values(p.env))];
    const { resolved, failures } = await secretResolver.refreshAll(envVarNames);
    connections.invalidate();
    res.json({ resolved: resolved.length, failures });
  } catch (e) { next(e); }
});

module.exports = router;
