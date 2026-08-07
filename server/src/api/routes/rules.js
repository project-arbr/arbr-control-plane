// Admin API routes — rules
const express = require("express");
const Rule = require("../../models/Rule");
const { logAction } = require("../auditLogger");
const { requireRole } = require("../rbac");
const ruleEngine = require("../../routing/ruleEngine");
const { feature } = require("../../cloud/entitlements");
const responseCache = require("../../routing/responseCache");
const semanticCache = require("../../routing/semanticCache");
const connections = require("../../providers/connections");
const pricing = require("../../pricing/registry");
const { explainRoute } = require("../../routing/explainRoute");
const { getAppConfig } = require("../../gateway/handler");

const router = express.Router();

// Annotate each rule with the config-time health of its target, so the console can
// flag a rule that points at an offline / unknown / unpriced model before it bites.
async function withHealth(rules) {
  const eff = await connections.effective();
  return rules.map((r) => ({
    ...r,
    health: ruleEngine.ruleTargetHealth(r.target, {
      liveIds: eff.liveIds,
      modelEntry: pricing.getModel(r.target?.model),
    }),
  }));
}

// ── rules ──
router.get("/rules", async (_req, res, next) => {
  try { res.json(await withHealth(await Rule.find().sort({ createdAt: -1 }).lean())); } catch (e) { next(e); }
});

router.post("/rules", requireRole("operator"), async (req, res, next) => {
  try {
    const { condition = {}, target, enabled = false, note = "", priority = 0 } = req.body || {};
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
      priority: Number.isFinite(+priority) ? Math.trunc(+priority) : 0,
      qualityGate: "ungated", // manual rules have no eval proof
    });
    ruleEngine.invalidate();
    setImmediate(() => logAction("rule.create", "rule", rule._id, { condition: rule.condition, target, enabled: !!enabled }, req.user));
    res.json((await withHealth([rule.toObject()]))[0]);
  } catch (e) { next(e); }
});

// Toggle / update enabled state.
router.patch("/rules/:id", requireRole("operator"), async (req, res, next) => {
  try {
    const update = {};
    if (typeof req.body.enabled === "boolean") update.enabled = req.body.enabled;
    if (req.body.note != null) update.note = req.body.note;
    if (req.body.priority != null && Number.isFinite(+req.body.priority)) update.priority = Math.trunc(+req.body.priority);
    const rule = await Rule.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!rule) return res.status(404).json({ error: "not found" });
    ruleEngine.invalidate();
    setImmediate(() => logAction("rule.update", "rule", req.params.id, update, req.user));
    res.json(rule);
  } catch (e) { next(e); }
});

router.delete("/rules/:id", requireRole("operator"), async (req, res, next) => {
  try {
    await Rule.findByIdAndDelete(req.params.id);
    ruleEngine.invalidate();
    setImmediate(() => logAction("rule.delete", "rule", req.params.id, null, req.user));
    res.json({ ok: true });
  } catch (e) { next(e); }
});


// Clear the in-memory response cache (useful when testing routing on repeated prompts).
router.post("/cache/clear", requireRole("operator"), (_req, res) => {
  responseCache.clear();
  res.json({ cleared: true });
});

// Clear the semantic (embedding-based) cache independently.
router.post("/cache/semantic/clear", requireRole("operator"), (_req, res) => {
  semanticCache.clear();
  res.json({ cleared: true, size: 0 });
});

// Current semantic cache entry count (for the UI status display).
router.get("/cache/semantic/stats", (_req, res) => {
  res.json({ size: semanticCache.size() });
});

// Dry-run route preview: "given this hypothetical request, which model would Arbr
// serve, and why?" — computed through the real routing path with no provider call,
// no billable classification, and no logging. Routing rejections (unresolvable pin,
// vision, not-allowed) are returned as a preview OUTCOME, not an error.
router.post("/routing/explain", requireRole("operator"), async (req, res, next) => {
  try {
    const eff = await connections.effective();
    const b = req.body || {};
    // Coerce every free-text field to a string so a JSON object can't become a
    // query operator or a template-injection surprise downstream.
    const str = (v) => (v == null ? undefined : String(v));
    const model = str(b.model), provider = str(b.provider), taskType = str(b.taskType);
    const application = str(b.application), workflow = str(b.workflow);
    const hasImage = !!b.hasImage;
    const appDbConfig = application ? await getAppConfig(application) : null;
    const appConfig = {
      allowedModels: Array.isArray(b.allowedModels) ? b.allowedModels.map(String) : [],
      defaultModel: str(b.defaultModel) || null,
    };
    const result = await explainRoute(
      { model, provider, taskType, application, workflow, hasImage },
      { eff, appConfig, appDbConfig }
    );
    res.json(result);
  } catch (err) {
    if (err.status && err.code) {
      return res.json({
        rejected: {
          code: err.code, message: err.message, status: err.status,
          ...(err.suggestions ? { did_you_mean: err.suggestions } : {}),
          ...(err.visionModels ? { vision_models: err.visionModels } : {}),
        },
      });
    }
    next(err);
  }
});

// Auto-mode routing engine: "off" | "guardrail" | "ai".
router.get("/routing-mode", async (_req, res, next) => {
  try { res.json({ routingMode: await ruleEngine.getRoutingMode() }); } catch (e) { next(e); }
});

router.put("/routing-mode", requireRole("administrator"), async (req, res, next) => {
  try {
    // "ai" mode is the paid feature; "off"/"guardrail" stay available on every plan.
    if (String(req.body?.mode) === "ai" && !feature(req, "ai_routing")) {
      return res.status(402).json({ error: "upgrade_required", feature: "ai_routing", message: "AI routing requires a paid plan." });
    }
    const mode = await ruleEngine.setRoutingMode(req.body?.mode);
    res.json({ routingMode: mode });
  } catch (e) { next(e); }
});


module.exports = router;
