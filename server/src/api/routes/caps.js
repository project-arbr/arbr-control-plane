// Admin API routes — caps
const express = require("express");
const Cap = require("../../models/Cap");
const { logAction } = require("../auditLogger");
const capEngine = require("../../routing/capEngine");
const { capStatus } = require("./_shared");

const router = express.Router();

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


module.exports = router;
