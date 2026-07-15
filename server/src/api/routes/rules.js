// Admin API routes — rules
const express = require("express");
const Rule = require("../../models/Rule");
const { logAction } = require("../auditLogger");
const ruleEngine = require("../../routing/ruleEngine");
const responseCache = require("../../routing/responseCache");

const router = express.Router();

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


module.exports = router;
