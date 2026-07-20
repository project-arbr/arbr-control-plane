// Admin API routes — recommendations
const express = require("express");
const RequestRecord = require("../../models/RequestRecord");
const Rule = require("../../models/Rule");
const Recommendation = require("../../models/Recommendation");
const { logAction } = require("../auditLogger");
const { requireRole } = require("../rbac");
const recommender = require("../../recommend/engine");
const ruleEngine = require("../../routing/ruleEngine");
const EvalDataset = require("../../models/EvalDataset");
const evalDatasetBuilder = require("../../eval/dataset");
const evalReplay = require("../../eval/replay");
const evalThresholds = require("../../eval/thresholds");
const { sameFamily } = require("../../eval/rubricJudge");
const { tierForTask } = require("../../classify/classifier");
const stageBatch = require("../../recommend/stageBatch");
const outcome = require("../../recommend/outcome");

const router = express.Router();

// ── recommendations ──
// Every recommendation carries a derived lifecycle `stage` (F-03: unified optimization
// workflow) — computed fresh from linked dataset/run/campaign/experiment/rule state, never
// stored, so it can never drift from what's actually happened. See recommend/stage.js.
router.get("/recommendations", async (req, res, next) => {
  try {
    const q = req.query.status ? { status: req.query.status } : {};
    const recs = await Recommendation.find(q).sort({ projectedSavings: -1 }).lean();
    res.json(await stageBatch.attachStages(recs));
  } catch (e) { next(e); }
});

// Explains the recommendation landscape (powers the self-diagnosing empty state): what was
// analyzed, and the high-spend task types excluded only because they aren't marked cheap.
router.get("/recommendations/analysis", async (_req, res, next) => {
  try { res.json(await recommender.analyze()); } catch (e) { next(e); }
});

router.post("/recommendations/recompute", requireRole("operator"), async (_req, res, next) => {
  try { res.json(await recommender.recompute()); } catch (e) { next(e); }
});

// Projected-vs-realised outcome for a promoted_live recommendation (F-03). Deliberately NOT
// inlined into the list endpoint above — two extra aggregations per row on every list load is
// the wrong default cost; the UI calls this on-demand when a "Live" card's outcome panel opens.
router.get("/recommendations/:id/outcome", async (req, res, next) => {
  try {
    const rec = await Recommendation.findById(req.params.id).lean();
    if (!rec) return res.status(404).json({ error: "not found" });
    res.json(await outcome.computeOutcome(rec));
  } catch (e) { next(e); }
});

// Accept → create a disabled rule from the recommendation, mark accepted.
// GATE (P0 eval-backed routing): a recommendation may only become a rule once it has PASSED an
// offline eval, or the caller supplies an override { reason, approver, expiresAt? }. This is the
// core promise — no cost-saving rule ships on price math alone. Pass ?dryRun=1 to check the gate.
router.post("/recommendations/:id/accept", requireRole("operator"), async (req, res, next) => {
  try {
    const rec = await Recommendation.findById(req.params.id);
    if (!rec) return res.status(404).json({ error: "not found" });

    const rawOverride = (req.body && req.body.override) || null;
    const override = rawOverride && rawOverride.reason
      ? { reason: rawOverride.reason, approver: req.user.email, expiresAt: rawOverride.expiresAt || null }
      : null;
    const gate = evalThresholds.gateAccept(rec, override);
    if (!gate.allowed) {
      return res.status(409).json({ error: "eval_required", message: gate.reason, evalStatus: rec.evalStatus });
    }
    if (gate.status === "overridden") {
      rec.evalStatus = "overridden";
      rec.override = { reason: override.reason, approver: override.approver, at: new Date(), expiresAt: override.expiresAt };
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
    const qualityGate = gate.status === "passed" ? "passed" : "overridden";
    const rule = await Rule.create({
      condition,
      target: { provider: rec.suggestedProvider, model: rec.suggestedModel },
      enabled: false, // human must explicitly switch it on
      createdBy: "console",
      sourceRecommendation: rec._id,
      qualityGate,
      note: rec.title,
    });
    rec.status = "accepted";
    rec.acceptedVia = qualityGate;
    await rec.save();
    ruleEngine.invalidate();
    setImmediate(() => logAction("recommendation.accept", "recommendation", String(rec._id), {
      via: qualityGate, ruleId: String(rule._id), candidateModel: rec.suggestedModel,
      evalRunId: rec.evalRunId ? String(rec.evalRunId) : null, qualityGate,
    }, req.user));
    res.json({ recommendation: rec, rule, acceptedVia: qualityGate, qualityGate });
  } catch (e) { next(e); }
});

// Build an immutable eval dataset from historical traffic for this recommendation's scope.
router.post("/recommendations/:id/create-eval-dataset", requireRole("operator"), async (req, res, next) => {
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
    setImmediate(() => logAction("eval.dataset.create", "evalDataset", String(dataset._id), { recommendationId: String(rec._id), itemCount: dataset.itemCount, status: dataset.status }, req.user));
    if (dataset.status === "failed") {
      // Surface the reason as `message` so the UI shows *why*, not a bare "422".
      const body = dataset.toObject ? dataset.toObject() : dataset;
      return res.status(422).json({ ...body, error: "no_replayable_traffic", message: dataset.error });
    }
    res.json(dataset);
  } catch (e) { next(e); }
});

// Start an offline eval run for this recommendation (uses its latest ready dataset, or a given datasetId).
router.post("/recommendations/:id/run-eval", requireRole("operator"), async (req, res, next) => {
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
    setImmediate(() => logAction("eval.run.start", "evalRun", String(run._id), { recommendationId: String(rec._id), candidateModel: dataset.candidateModel, judgeModel: judgeModel || null }, req.user));
    res.status(run.status === "failed" ? 422 : 202).json(run);
  } catch (e) { next(e); }
});

// Record a manual override reason on a recommendation (audited). Does not create the rule;
// the subsequent accept call carries the override, or reads this one.
router.post("/recommendations/:id/override", requireRole("operator"), async (req, res, next) => {
  try {
    const { reason, expiresAt } = req.body || {};
    if (!reason) return res.status(400).json({ error: "reason is required" });
    const rec = await Recommendation.findById(req.params.id);
    if (!rec) return res.status(404).json({ error: "not found" });
    const approver = req.user.email;
    rec.override = { reason, approver, at: new Date(), expiresAt: expiresAt || null };
    rec.evalStatus = "overridden";
    await rec.save();
    setImmediate(() => logAction("eval.override", "recommendation", String(rec._id), { approver, reason }, req.user));
    res.json(rec);
  } catch (e) { next(e); }
});

// Create an eval directly (not from a recommendation): build a dataset from an application's
// recent single-shot traffic and start an offline run comparing a candidate model against the
// baseline. Lets users test ANY candidate, recommended or not. Mirrors the recommendation
// create-dataset + run-eval flow in one call, reusing the same builder/runner with a
// recommendation-shaped scope (recommendationId stays null).
router.post("/evals", requireRole("operator"), async (req, res, next) => {
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
    // Exploratory: don't block on the risk-tier promotion floor (200/300/500) — evaluate whatever
    // traffic is actually available. Flagged exploratory so a pass reads as a directional signal,
    // not a promotion-grade result. The other gates (worse-rate, latency, cost) still apply.
    thresholds.minItems = Math.max(1, dataset.itemCount || 1);
    const run = await evalReplay.startRun({ rec: null, dataset, judgeModel: judgeModel || null, thresholds, maxRunCostUsd: maxRunCostUsd ?? null, exploratory: true });
    setImmediate(() => logAction("eval.create", "evalRun", String(run._id), { application, baselineModel, candidateModel, judgeModel: judgeModel || null, exploratory: true }, req.user));
    res.status(run.status === "failed" ? 422 : 201).json({ dataset, run });
  } catch (e) { next(e); }
});

// Models that have actually served an application's replayable traffic, with per-model counts —
// the valid BASELINE choices for a new eval (you can't beat a model with no traffic). Same
// eligibility proxy as the recommendation "replayable" count (captured prompt + response,
// non-cache); single-shot is refined at dataset build, so counts are an upper-bound estimate.
router.get("/evals/traffic-models", async (req, res, next) => {
  try {
    const { application } = req.query;
    if (!application) return res.status(400).json({ error: "application is required" });
    const days = Math.max(1, parseInt(req.query.windowDays, 10) || 60);
    const since = new Date(Date.now() - days * 86400000);
    const rows = await RequestRecord.aggregate([
      { $match: {
        application, status: "success", cacheHit: { $ne: true },
        messages: { $ne: null }, responseText: { $exists: true, $nin: [null, ""] },
        timestamp: { $gte: since },
      } },
      { $group: { _id: { model: "$model", provider: "$provider" }, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);
    res.json(rows.map((r) => ({ model: r._id.model, provider: r._id.provider, count: r.count })));
  } catch (e) { next(e); }
});


module.exports = router;
