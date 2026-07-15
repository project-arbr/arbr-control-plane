// Admin API routes — shadow
const express = require("express");
const Recommendation = require("../../models/Recommendation");
const { logAction } = require("../auditLogger");
const EvalCampaign = require("../../models/EvalCampaign");
const EvalPair = require("../../models/EvalPair");
const EvalRun = require("../../models/EvalRun");
const { invalidateCampaignCache } = require("../../eval/shadow");
const { summarizeEvalPairs } = require("../../eval/logic");
const evalThresholds = require("../../eval/thresholds");

const router = express.Router();

// ── Shadow-eval campaigns ─────────────────────────────────────────────────────
router.get("/eval/campaigns", async (req, res, next) => {
  try {
    const campaigns = await EvalCampaign.find().sort({ createdAt: -1 }).lean();
    const withCounts = await Promise.all(campaigns.map(async (c) => ({
      ...c, pairCount: await EvalPair.countDocuments({ campaignId: c._id }),
    })));
    res.json(withCounts);
  } catch (e) { next(e); }
});

router.post("/eval/campaigns", async (req, res, next) => {
  try {
    const b = req.body || {};
    const { application, candidateModel, judgeModel, sampleRate, thresholds, name, baselineModel, scope,
      requiredEvalRunId, maxDailyShadowBudgetUsd, maxCandidateErrors, startDate, endDate, override } = b;
    if (!application) return res.status(400).json({ error: "application is required" });
    if (!candidateModel) return res.status(400).json({ error: "candidateModel is required" });

    // Phase 2 gate: a campaign only goes ACTIVE if a linked offline eval passed (or overridden);
    // otherwise it is created PAUSED with the reason, ready to activate once the eval passes.
    const wantActive = b.status !== "paused";
    const offlineRun = requiredEvalRunId ? await EvalRun.findById(requiredEvalRunId).lean().catch(() => null) : null;
    const gate = evalThresholds.canActivateShadow(offlineRun, override);
    const status = wantActive && gate.allowed ? "active" : "paused";
    const statusReason = status === "paused" && wantActive ? gate.reason : null;

    const doc = await EvalCampaign.create({
      application, candidateModel, name: name || "",
      baselineModel: baselineModel || null,
      judgeModel: judgeModel || null,
      scope: { workflow: scope?.workflow || null, taskType: scope?.taskType || null },
      requiredEvalRunId: requiredEvalRunId || null,
      maxDailyShadowBudgetUsd: maxDailyShadowBudgetUsd != null ? Number(maxDailyShadowBudgetUsd) : null,
      maxCandidateErrors: maxCandidateErrors != null ? Math.max(1, Number(maxCandidateErrors)) : null,
      startDate: startDate || null, endDate: endDate || null,
      status, statusReason,
      sampleRate: sampleRate != null ? Math.min(1, Math.max(0, Number(sampleRate))) : 0.1,
      thresholds: {
        minPairs: thresholds?.minPairs != null ? Math.max(1, Number(thresholds.minPairs)) : 50,
        maxLossRate: thresholds?.maxLossRate != null ? Math.min(1, Math.max(0, Number(thresholds.maxLossRate))) : 0.1,
      },
    });
    invalidateCampaignCache();
    setImmediate(() => logAction("evalCampaign.create", "evalCampaign", String(doc._id), { application, candidateModel, status }));
    res.status(201).json(doc);
  } catch (e) { next(e); }
});

router.get("/eval/campaigns/:id", async (req, res, next) => {
  try {
    const c = await EvalCampaign.findById(req.params.id).lean().catch(() => null);
    if (!c) return res.status(404).json({ error: "not found" });
    const pairs = await EvalPair.find({ campaignId: c._id },
      { prodCost: 1, candidateCost: 1, prodLatencyMs: 1, candidateLatencyMs: 1, verdict: 1 }).lean();
    // Worst candidate examples for the evidence view (Phase 2).
    const worstExamples = await EvalPair.find({ campaignId: c._id, verdict: "worse" })
      .sort({ timestamp: -1 }).limit(20).lean();
    res.json({ ...c, summary: summarizeEvalPairs(pairs), worstExamples });
  } catch (e) { next(e); }
});

// Start a shadow campaign directly from a recommendation (requires its offline eval passed).
router.post("/recommendations/:id/start-shadow", async (req, res, next) => {
  try {
    const rec = await Recommendation.findById(req.params.id);
    if (!rec) return res.status(404).json({ error: "not found" });
    const b = req.body || {};
    const application = b.application || rec.application;
    if (!application) return res.status(400).json({ error: "application is required (recommendations are not app-scoped)" });

    const offlineRun = rec.evalRunId ? await EvalRun.findById(rec.evalRunId).lean().catch(() => null) : null;
    const gate = evalThresholds.canActivateShadow(offlineRun, b.override);
    if (!gate.allowed) return res.status(409).json({ error: "eval_required", message: gate.reason });

    const campaign = await EvalCampaign.create({
      name: `shadow: ${rec.currentModel} → ${rec.suggestedModel}`,
      application, candidateModel: rec.suggestedModel, baselineModel: rec.currentModel,
      judgeModel: b.judgeModel || null,
      scope: { taskType: rec.taskType || null, workflow: b.workflow || null },
      recommendationId: rec._id, requiredEvalRunId: rec.evalRunId || null,
      sampleRate: b.sampleRate != null ? Math.min(1, Math.max(0, Number(b.sampleRate))) : 0.1,
      maxDailyShadowBudgetUsd: b.maxDailyShadowBudgetUsd != null ? Number(b.maxDailyShadowBudgetUsd) : null,
      maxCandidateErrors: b.maxCandidateErrors != null ? Math.max(1, Number(b.maxCandidateErrors)) : null,
      startDate: b.startDate || null, endDate: b.endDate || null,
      status: "active",
    });
    rec.shadowCampaignId = campaign._id;
    await rec.save();
    invalidateCampaignCache();
    setImmediate(() => logAction("eval.shadow.start", "evalCampaign", String(campaign._id), { recommendationId: String(rec._id), via: offlineRun?.status === "passed" ? "passed" : "override" }));
    res.status(201).json(campaign);
  } catch (e) { next(e); }
});

router.get("/eval/campaigns/:id/pairs", async (req, res, next) => {
  try {
    const items = await EvalPair.find({ campaignId: req.params.id }).sort({ timestamp: -1 }).limit(50).lean();
    res.json({ items });
  } catch (e) { next(e); }
});

router.patch("/eval/campaigns/:id", async (req, res, next) => {
  try {
    const b = req.body || {};
    const existing = await EvalCampaign.findById(req.params.id).lean().catch(() => null);
    if (!existing) return res.status(404).json({ error: "not found" });

    const update = {};
    // Activating is gated on a passed offline eval (Phase 2), unless overridden.
    if (b.status && ["active", "paused", "done"].includes(b.status)) {
      if (b.status === "active" && existing.status !== "active") {
        const runId = b.requiredEvalRunId || existing.requiredEvalRunId;
        const offlineRun = runId ? await EvalRun.findById(runId).lean().catch(() => null) : null;
        const gate = evalThresholds.canActivateShadow(offlineRun, b.override);
        if (!gate.allowed) return res.status(409).json({ error: "eval_required", message: gate.reason });
        update.statusReason = null;
        update.candidateErrorCount = 0; // reset the safety counter on a fresh activation
      }
      update.status = b.status;
    }
    if (b.sampleRate != null) update.sampleRate = Math.min(1, Math.max(0, Number(b.sampleRate)));
    if (b.judgeModel !== undefined) update.judgeModel = b.judgeModel || null;
    if (b.baselineModel !== undefined) update.baselineModel = b.baselineModel || null;
    if (b.scope) update.scope = { workflow: b.scope.workflow || null, taskType: b.scope.taskType || null };
    if (b.requiredEvalRunId !== undefined) update.requiredEvalRunId = b.requiredEvalRunId || null;
    if (b.maxDailyShadowBudgetUsd !== undefined) update.maxDailyShadowBudgetUsd = b.maxDailyShadowBudgetUsd != null ? Number(b.maxDailyShadowBudgetUsd) : null;
    if (b.maxCandidateErrors !== undefined) update.maxCandidateErrors = b.maxCandidateErrors != null ? Math.max(1, Number(b.maxCandidateErrors)) : null;
    if (b.startDate !== undefined) update.startDate = b.startDate || null;
    if (b.endDate !== undefined) update.endDate = b.endDate || null;
    if (b.thresholds) update.thresholds = {
      minPairs: b.thresholds.minPairs != null ? Math.max(1, Number(b.thresholds.minPairs)) : 50,
      maxLossRate: b.thresholds.maxLossRate != null ? Math.min(1, Math.max(0, Number(b.thresholds.maxLossRate))) : 0.1,
    };
    const c = await EvalCampaign.findByIdAndUpdate(req.params.id, { $set: update }, { new: true }).lean();
    invalidateCampaignCache();
    res.json(c);
  } catch (e) { next(e); }
});

router.delete("/eval/campaigns/:id", async (req, res, next) => {
  try {
    await EvalCampaign.findByIdAndDelete(req.params.id);
    await EvalPair.deleteMany({ campaignId: req.params.id });
    invalidateCampaignCache();
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;

module.exports = router;
