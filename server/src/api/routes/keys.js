// Admin API routes — keys
const express = require("express");
const ApiKey = require("../../models/ApiKey");
const auth = require("../../gateway/auth");
const { logAction } = require("../auditLogger");
const crypto = require("crypto");

const router = express.Router();

// ── gateway API keys (virtual keys) ──
function keyView(d) {
  return {
    _id: d._id, name: d.name, application: d.application, prefix: d.prefix,
    enabled: d.enabled, rpm: d.rpm, createdAt: d.createdAt, lastUsedAt: d.lastUsedAt,
    userId: d.userId || null, department: d.department || null,
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
    const { name, application, rpm, allowedModels, defaultModel, userId, department } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: "name is required" });
    if (!application || !String(application).trim()) return res.status(400).json({ error: "application is required" });
    const secret = "ab_" + crypto.randomBytes(16).toString("hex");
    const doc = await ApiKey.create({
      name: String(name).trim(),
      application: String(application).trim(),
      keyHash: auth.hashKey(secret),
      prefix: `ab_…${secret.slice(-4)}`,
      rpm: Number(rpm) > 0 ? Number(rpm) : null,
      userId: userId ? String(userId).trim() || null : null,
      department: department ? String(department).trim() || null : null,
      allowedModels: Array.isArray(allowedModels) ? allowedModels.filter(Boolean) : [],
      defaultModel: defaultModel ? String(defaultModel).trim() || null : null,
    });
    auth.invalidate();
    setImmediate(() => logAction("key.create", "key", doc._id, { name: doc.name, application: doc.application, userId: doc.userId }));
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
    if ("userId" in req.body) update.userId = req.body.userId ? String(req.body.userId).trim() || null : null;
    if ("department" in req.body) update.department = req.body.department ? String(req.body.department).trim() || null : null;
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


module.exports = router;
