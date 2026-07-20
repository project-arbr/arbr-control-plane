// Admin API routes — evalBenchmarks
const express = require("express");
const RequestRecord = require("../../models/RequestRecord");
const { logAction } = require("../auditLogger");
const { toRouterConfig, getRouter } = require("../../providers/router");
const pricing = require("../../pricing/registry");
const Settings = require("../../models/Settings");
const EvalDataset = require("../../models/EvalDataset");
const EvalItem = require("../../models/EvalItem");
const EvalRun = require("../../models/EvalRun");
const EvalResult = require("../../models/EvalResult");
const evalDatasetBuilder = require("../../eval/dataset");
const evalReplay = require("../../eval/replay");
const evalThresholds = require("../../eval/thresholds");
const { efficiencyOf } = require("../../eval/efficiency");
const { judgeReliability } = require("../../eval/judgeReliability");
const { sameFamily } = require("../../eval/rubricJudge");
const { tierForTask } = require("../../classify/classifier");

const router = express.Router();

// ── Reusable benchmarks ("DashBench") ─────────────────────────────────────────
// A benchmark is a NAMED, frozen set of an application's traffic. Run many candidate models
// against the SAME set and rank them by quality-per-dollar on your own workload — the point
// DoorDash's DashBench proved: generic leaderboards don't predict your traffic.

// Build a benchmark from an application's replayable traffic (candidate-agnostic).
router.post("/eval-benchmarks", async (req, res, next) => {
  try {
    const { name, application, taskType, baselineModel, targetCount, windowDays } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: "name is required" });
    if (!application) return res.status(400).json({ error: "application is required" });
    if (!baselineModel) return res.status(400).json({ error: "baselineModel is required" });
    // rec-shaped scope with no candidate — the benchmark is scored against many candidates later.
    const scope = { _id: null, application, taskType: taskType || null, currentModel: baselineModel, suggestedModel: null };
    const dataset = await evalDatasetBuilder.createFromTraffic({ rec: scope, targetCount, windowDays, isBenchmark: true, name: name.trim() });
    if (dataset.status !== "ready") {
      const body = dataset.toObject ? dataset.toObject() : dataset;
      return res.status(422).json({ ...body, error: "no_replayable_traffic", message: dataset.error });
    }
    setImmediate(() => logAction("benchmark.create", "evalDataset", String(dataset._id), { name: name.trim(), application, baselineModel, itemCount: dataset.itemCount }));
    res.status(201).json(dataset);
  } catch (e) { next(e); }
});

// List benchmarks with their run counts.
router.get("/eval-benchmarks", async (req, res, next) => {
  try {
    const benches = await EvalDataset.find({ isBenchmark: true }).sort({ createdAt: -1 }).lean();
    const withCounts = await Promise.all(benches.map(async (b) => ({
      ...b, runCount: await EvalRun.countDocuments({ datasetId: b._id }),
    })));
    res.json(withCounts);
  } catch (e) { next(e); }
});

// One benchmark + its leaderboard: every candidate run, ranked by quality-per-dollar.
router.get("/eval-benchmarks/:id", async (req, res, next) => {
  try {
    const bench = await EvalDataset.findById(req.params.id).lean().catch(() => null);
    if (!bench || !bench.isBenchmark) return res.status(404).json({ error: "not found" });
    const runs = await EvalRun.find({ datasetId: bench._id }).sort({ createdAt: -1 }).lean();
    // Per-run judge reliability from the stored verdicts (position bias + decisiveness).
    const leaderboard = await Promise.all(runs.map(async (r) => {
      const verdicts = await EvalResult.find({ evalRunId: r._id }, { judgeVerdict: 1, abFlipped: 1 }).lean();
      return { ...r, efficiency: efficiencyOf(r.summary, r.actualCostUsd), judge: judgeReliability(verdicts) };
    }));
    leaderboard.sort((a, b) => (b.efficiency.qualityPerDollar ?? -1) - (a.efficiency.qualityPerDollar ?? -1));

    // "Auto-benchmark" (cost-safe): connected, chat-capable models CHEAPER than the baseline that
    // haven't been scored yet — the candidates most worth trying. Suggestions only; scoring (which
    // spends tokens) stays a human click. Ranked by biggest saving vs the baseline.
    const avgPrice = (m) => ((m?.inputPer1M || 0) + (m?.outputPer1M || 0)) / 2;
    const basePrice = avgPrice(pricing.getModel(bench.baselineModel));
    const scored = new Set(runs.map((r) => r.candidateModel));
    let suggestedCandidates = [];
    if (basePrice > 0) {
      const { eff } = await getRouter().catch(() => ({}));
      const liveIds = new Set(eff?.liveIds || []);
      suggestedCandidates = pricing.listModels()
        .filter((m) => liveIds.has(m.provider) && m.chatCapable !== false && m.id !== bench.baselineModel
          && !scored.has(m.id) && avgPrice(m) > 0 && avgPrice(m) < basePrice)
        .map((m) => ({ model: m.id, provider: m.provider, label: m.label || m.id, tier: m.tier,
          savingVsBaselinePct: (basePrice - avgPrice(m)) / basePrice }))
        .sort((a, b) => b.savingVsBaselinePct - a.savingVsBaselinePct)
        .slice(0, 6);
    }
    res.json({ ...bench, leaderboard, suggestedCandidates });
  } catch (e) { next(e); }
});

// Score a candidate model against the benchmark (a new EvalRun over the same frozen items).
router.post("/eval-benchmarks/:id/run", async (req, res, next) => {
  try {
    const bench = await EvalDataset.findById(req.params.id).catch(() => null);
    if (!bench || !bench.isBenchmark) return res.status(404).json({ error: "not found" });
    if (bench.status !== "ready") return res.status(409).json({ error: "benchmark not ready" });
    const { candidateModel, judgeModel, maxRunCostUsd } = req.body || {};
    if (!candidateModel) return res.status(400).json({ error: "candidateModel is required" });
    if (candidateModel === bench.baselineModel) return res.status(400).json({ error: "candidate must differ from the benchmark baseline" });
    if (bench.riskTier === "high" && judgeModel && sameFamily(judgeModel, candidateModel)) {
      return res.status(422).json({ error: "judge_same_family", message: "For high-risk tasks the judge must not be from the candidate's model family." });
    }
    // The benchmark IS the sample, so don't gate on the promotion floor — score whatever it holds.
    const thresholds = evalThresholds.defaultThresholds(evalThresholds.riskForTier(tierForTask(bench.scope?.taskType)));
    thresholds.minItems = Math.max(1, bench.itemCount || 1);
    const run = await evalReplay.startRun({ rec: null, dataset: bench, judgeModel: judgeModel || null, thresholds, candidateModel, maxRunCostUsd: maxRunCostUsd ?? null });
    setImmediate(() => logAction("benchmark.run", "evalRun", String(run._id), { benchmarkId: String(bench._id), candidateModel, judgeModel: judgeModel || null }));
    res.status(run.status === "failed" ? 422 : 201).json(run);
  } catch (e) { next(e); }
});

// Delete a benchmark and everything derived from it (items, its runs, their results).
router.delete("/eval-benchmarks/:id", async (req, res, next) => {
  try {
    const bench = await EvalDataset.findById(req.params.id).lean().catch(() => null);
    if (!bench || !bench.isBenchmark) return res.status(404).json({ error: "not found" });
    const runs = await EvalRun.find({ datasetId: bench._id }, { _id: 1 }).lean();
    await EvalResult.deleteMany({ evalRunId: { $in: runs.map((r) => r._id) } });
    await EvalRun.deleteMany({ datasetId: bench._id });
    await EvalItem.deleteMany({ datasetId: bench._id });
    await EvalDataset.deleteOne({ _id: bench._id });
    setImmediate(() => logAction("benchmark.delete", "evalDataset", String(req.params.id), { name: bench.name }));
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Curation: pin a specific logged request into a benchmark as a case (e.g. one that went wrong).
router.post("/eval-benchmarks/:id/items", async (req, res, next) => {
  try {
    const bench = await EvalDataset.findById(req.params.id).catch(() => null);
    if (!bench || !bench.isBenchmark) return res.status(404).json({ error: "not found" });
    const { requestId, severity } = req.body || {};
    if (!requestId) return res.status(400).json({ error: "requestId is required" });
    const rec = await RequestRecord.findOne({ requestId }).lean().catch(() => null);
    if (!rec) return res.status(404).json({ error: "request not found" });
    if (!evalDatasetBuilder.isEligible(rec)) return res.status(422).json({ error: "not_replayable", message: "That request has no captured single-shot prompt + response to replay." });
    if (await EvalItem.findOne({ datasetId: bench._id, requestId })) return res.status(409).json({ error: "already_in_benchmark", message: "That request is already a case in this benchmark." });

    const settings = await Settings.get().catch(() => ({}));
    if (settings.captureRequestPayloads === false) {
      return res.status(409).json({
        error: "payload_capture_disabled",
        message: "Enable payload capture before copying request content into an evaluation benchmark.",
      });
    }
    const { messages, productionResponse } = evalDatasetBuilder.projectText(
      rec, bench.piiMode, !!settings.piiMaskingEnabled, settings.customPiiPatterns || [], true
    );
    const sev = ["trivial", "normal", "critical"].includes(severity) ? severity : "normal";
    const item = await EvalItem.create({
      datasetId: bench._id, requestId: rec.requestId, application: rec.application || null,
      workflow: rec.workflow || null, taskType: rec.taskType || null, currentModel: rec.model || null,
      messages, productionResponse, productionCost: rec.totalCost || 0, productionLatencyMs: rec.latencyMs || 0,
      promptHash: evalDatasetBuilder.promptHashOf(rec.messages), responseHash: evalDatasetBuilder.responseHashOf(rec.responseText),
      severity: sev, pinned: true,
    });
    await EvalDataset.updateOne({ _id: bench._id }, { $inc: { itemCount: 1 } });
    setImmediate(() => logAction("benchmark.item.add", "evalItem", String(item._id), { benchmarkId: String(bench._id), requestId, severity: sev }));
    res.status(201).json(item);
  } catch (e) { next(e); }
});

// List a benchmark's cases (for curation) — compact, with a response preview.
router.get("/eval-benchmarks/:id/items", async (req, res, next) => {
  try {
    const bench = await EvalDataset.findById(req.params.id).lean().catch(() => null);
    if (!bench || !bench.isBenchmark) return res.status(404).json({ error: "not found" });
    const items = await EvalItem.find({ datasetId: bench._id },
      { requestId: 1, taskType: 1, severity: 1, pinned: 1, productionResponse: 1 }).sort({ createdAt: -1 }).lean();
    res.json(items.map((it) => ({
      _id: it._id, requestId: it.requestId, taskType: it.taskType, severity: it.severity || "normal",
      pinned: !!it.pinned, preview: String(it.productionResponse || "").slice(0, 140),
    })));
  } catch (e) { next(e); }
});

// Set a case's severity (weights the worse-rate on the next run).
router.patch("/eval-items/:id", async (req, res, next) => {
  try {
    const { severity } = req.body || {};
    if (!["trivial", "normal", "critical"].includes(severity)) return res.status(400).json({ error: "severity must be trivial | normal | critical" });
    const item = await EvalItem.findByIdAndUpdate(req.params.id, { $set: { severity } }, { new: true }).lean().catch(() => null);
    if (!item) return res.status(404).json({ error: "not found" });
    res.json(item);
  } catch (e) { next(e); }
});

// Remove a case from a benchmark.
router.delete("/eval-items/:id", async (req, res, next) => {
  try {
    const item = await EvalItem.findById(req.params.id).lean().catch(() => null);
    if (!item) return res.status(404).json({ error: "not found" });
    await EvalItem.deleteOne({ _id: item._id });
    await EvalDataset.updateOne({ _id: item.datasetId }, { $inc: { itemCount: -1 } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});


module.exports = router;
