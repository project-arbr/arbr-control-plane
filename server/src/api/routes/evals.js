// Admin API routes — evals
const express = require("express");
const Recommendation = require("../../models/Recommendation");
const { logAction } = require("../auditLogger");
const { requireRole } = require("../rbac");
const EvalDataset = require("../../models/EvalDataset");
const EvalItem = require("../../models/EvalItem");
const EvalRun = require("../../models/EvalRun");
const EvalResult = require("../../models/EvalResult");
const evalReplay = require("../../eval/replay");

const router = express.Router();

// ── Eval datasets / runs (read views) ─────────────────────────────────────────
router.get("/evals/datasets", async (req, res, next) => {
  try {
    const q = req.query.recommendationId ? { recommendationId: req.query.recommendationId } : {};
    res.json(await EvalDataset.find(q).sort({ createdAt: -1 }).lean());
  } catch (e) { next(e); }
});
router.get("/evals/datasets/:id", async (req, res, next) => {
  try {
    const ds = await EvalDataset.findById(req.params.id).lean().catch(() => null);
    if (!ds) return res.status(404).json({ error: "not found" });
    res.json({ ...ds, sampleItems: await EvalItem.find({ datasetId: ds._id }).limit(10).lean() });
  } catch (e) { next(e); }
});
router.get("/evals/runs", async (req, res, next) => {
  try {
    const q = req.query.recommendationId ? { recommendationId: req.query.recommendationId } : {};
    res.json(await EvalRun.find(q).sort({ createdAt: -1 }).lean());
  } catch (e) { next(e); }
});
router.get("/evals/runs/:id", async (req, res, next) => {
  try {
    const run = await EvalRun.findById(req.params.id).lean().catch(() => null);
    if (!run) return res.status(404).json({ error: "not found" });
    res.json(run);
  } catch (e) { next(e); }
});
// Cancel a queued/running run; the worker stops it at the next checkpoint (queued stops immediately).
router.post("/evals/runs/:id/cancel", requireRole("operator"), async (req, res, next) => {
  try {
    const run = await EvalRun.findOneAndUpdate(
      { _id: req.params.id, status: { $in: ["queued", "running"] } },
      { $set: { status: "cancelled" } }, { new: true }
    ).lean().catch(() => null);
    if (!run) return res.status(409).json({ error: "not_cancellable", message: "run is not queued or running" });
    setImmediate(() => logAction("eval.run.cancel", "evalRun", req.params.id, null, req.user));
    res.json(run);
  } catch (e) { next(e); }
});
// Delete an eval run and its results. Also drops the dataset + its items when no other run
// references them (a manual eval owns its dataset), and clears a linked recommendation's pointer
// so its recorded verdict isn't left dangling.
router.delete("/evals/runs/:id", requireRole("operator"), async (req, res, next) => {
  try {
    const run = await EvalRun.findById(req.params.id).lean().catch(() => null);
    if (!run) return res.status(404).json({ error: "not found" });
    await EvalResult.deleteMany({ evalRunId: run._id });
    await EvalRun.deleteOne({ _id: run._id });

    let datasetDeleted = false;
    if (run.datasetId && (await EvalRun.countDocuments({ datasetId: run.datasetId })) === 0) {
      await EvalItem.deleteMany({ datasetId: run.datasetId });
      await EvalDataset.deleteOne({ _id: run.datasetId });
      datasetDeleted = true;
    }
    if (run.recommendationId) {
      await Recommendation.updateOne(
        { _id: run.recommendationId, evalRunId: run._id },
        { $set: { evalRunId: null, qualitySummary: null, evalStatus: datasetDeleted ? "not_started" : "dataset_ready",
          ...(datasetDeleted ? { evalDatasetId: null } : {}) } }
      ).catch(() => {});
    }
    setImmediate(() => logAction("eval.run.delete", "evalRun", String(run._id), { candidateModel: run.candidateModel }, req.user));
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Worst candidate examples first (worse verdicts + critical failures), for the evidence view.
router.get("/evals/runs/:id/results", async (req, res, next) => {
  try {
    const order = { worse: 0, equal: 1, better: 2 };
    const results = await EvalResult.find({ evalRunId: req.params.id }).lean();
    results.sort((a, b) =>
      (b.criticalFailure - a.criticalFailure) ||
      ((order[a.judgeVerdict] ?? 3) - (order[b.judgeVerdict] ?? 3)));
    res.json(results);
  } catch (e) { next(e); }
});

// Human-curated verdict: override (or clear) the judge on one result, then re-score the run.
router.patch("/evals/results/:id", requireRole("operator"), async (req, res, next) => {
  try {
    const { verdict } = req.body || {};
    if (verdict != null && !["better", "equal", "worse"].includes(verdict)) {
      return res.status(400).json({ error: "verdict must be better | equal | worse (or null to clear)" });
    }
    const result = await EvalResult.findByIdAndUpdate(req.params.id, { $set: { humanVerdict: verdict ?? null } }, { new: true }).lean().catch(() => null);
    if (!result) return res.status(404).json({ error: "not found" });
    const run = await evalReplay.recomputeRun(result.evalRunId); // re-score with the override
    setImmediate(() => logAction("eval.verdict.override", "evalResult", String(result._id), { verdict: verdict ?? null }, req.user));
    res.json({ result, run });
  } catch (e) { next(e); }
});

module.exports = router;
