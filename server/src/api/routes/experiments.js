// Admin API routes — experiments
const express = require("express");
const Rule = require("../../models/Rule");
const Recommendation = require("../../models/Recommendation");
const { logAction } = require("../auditLogger");
const ruleEngine = require("../../routing/ruleEngine");
const pricing = require("../../pricing/registry");
const EvalRun = require("../../models/EvalRun");
const evalThresholds = require("../../eval/thresholds");
const RoutingExperiment = require("../../models/RoutingExperiment");
const canaryEngine = require("../../routing/canaryEngine");

const router = express.Router();

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

// Create a canary directly (not from a recommendation) — e.g. from a passed offline eval.
// Same gate as shadow/recommendation: a passed offline run (requiredEvalRunId) or an override.
// Only auto-routed traffic is affected.
router.post("/routing-experiments", async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.application) return res.status(400).json({ error: "application is required" });
    if (!b.baselineModel) return res.status(400).json({ error: "baselineModel is required" });
    if (!b.candidateModel) return res.status(400).json({ error: "candidateModel is required" });

    const offlineRun = b.requiredEvalRunId ? await EvalRun.findById(b.requiredEvalRunId).lean().catch(() => null) : null;
    const gate = evalThresholds.canActivateShadow(offlineRun, b.override);
    if (!gate.allowed) return res.status(409).json({ error: "eval_required", message: gate.reason });

    const exp = await RoutingExperiment.create({
      evalRunId: b.requiredEvalRunId || null, recommendationId: null, shadowCampaignId: null,
      scope: { application: b.application, workflow: b.workflow || null, taskType: b.taskType || null },
      baselineModel: b.baselineModel, candidateModel: b.candidateModel,
      candidateProvider: b.candidateProvider || pricing.getModel(b.candidateModel)?.provider || null,
      rolloutPct: b.rolloutPct != null ? Math.min(100, Math.max(0, Number(b.rolloutPct))) : 10,
      guardrails: sanitizeGuardrails(b.guardrails),
      metricsWindowMinutes: b.metricsWindowMinutes != null ? Math.max(5, Number(b.metricsWindowMinutes)) : 60,
      status: "active", createdBy: "console", approvedBy: b.approvedBy || (b.override && b.override.approver) || null,
    });
    canaryEngine.invalidate();
    setImmediate(() => logAction("canary.create", "routingExperiment", String(exp._id), { application: b.application, candidateModel: b.candidateModel, rolloutPct: exp.rolloutPct }));
    res.status(201).json(exp);
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


module.exports = router;
