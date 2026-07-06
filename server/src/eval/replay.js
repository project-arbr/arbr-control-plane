// Offline replay: run a candidate model over a frozen EvalDataset, judge each item against the
// production response, aggregate, and gate pass/fail on risk-tiered thresholds. Runs as a
// background job (never in a request thread). Pure aggregation/estimation is separated from IO.
const pricing = require("../pricing/registry");
const { getRouter } = require("../providers/router");
const EvalDataset = require("../models/EvalDataset");
const EvalItem = require("../models/EvalItem");
const EvalRun = require("../models/EvalRun");
const EvalResult = require("../models/EvalResult");
const Recommendation = require("../models/Recommendation");
const { clampText, maskPii } = require("../logging/piiFilter");
const { judgeItem, runValidators, lastUserText } = require("./rubricJudge");
const { evaluateRun } = require("./thresholds");

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

// Aggregate per-item results (+ their production baselines) into a run summary. Pure.
// Each entry: { verdict, criticalFailure, formatPass, candidateCost, candidateLatencyMs,
//               productionCost, productionLatencyMs, errored }.
function aggregate(entries) {
  const total = entries.length;
  const ok = entries.filter((e) => !e.errored);
  const judged = ok.filter((e) => e.verdict);
  const better = judged.filter((e) => e.verdict === "better").length;
  const equal = judged.filter((e) => e.verdict === "equal").length;
  const worse = judged.filter((e) => e.verdict === "worse").length;
  const critical = ok.filter((e) => e.criticalFailure).length;
  const formatPasses = ok.filter((e) => e.formatPass).length;

  const prodCost = sum(ok, (e) => e.productionCost);
  const candCost = sum(ok, (e) => e.candidateCost);
  const prodLat = sum(ok, (e) => e.productionLatencyMs);
  const candLat = sum(ok, (e) => e.candidateLatencyMs);
  const n = ok.length || 1;

  const latDeltas = ok
    .filter((e) => e.productionLatencyMs > 0)
    .map((e) => (e.candidateLatencyMs - e.productionLatencyMs) / e.productionLatencyMs)
    .sort((a, b) => a - b);

  return {
    total, judged: judged.length,
    candidateBetter: better, candidateEqual: equal, candidateWorse: worse,
    worseRate: judged.length ? worse / judged.length : 0,
    criticalFailRate: ok.length ? critical / ok.length : 0,
    formatPassRate: ok.length ? formatPasses / ok.length : 1,
    prodCost, candidateCost: candCost,
    costSavingPct: prodCost > 0 ? (prodCost - candCost) / prodCost : 0,
    avgProdLatencyMs: prodLat / n, avgCandidateLatencyMs: candLat / n,
    avgLatencyDeltaPct: latDeltas.length ? latDeltas.reduce((a, b) => a + b, 0) / latDeltas.length : 0,
    p95LatencyDeltaPct: percentile(latDeltas, 95),
    errored: total - ok.length,
  };
}
function sum(arr, f) { return arr.reduce((a, x) => a + (Number(f(x)) || 0), 0); }

// Rough pre-run cost estimate (a guardrail, not a billing figure): scale summed production cost
// by the candidate's price ratio, plus a judge pass that re-reads both responses. Pure-ish
// (reads the pricing registry). `getModel` is injected for testability.
function estimateRunCost(items, baselineModel, candidateModel, judgeModel, getModel = pricing.getModel) {
  const rate = (id) => { const m = getModel(id); return m ? (m.inputPer1M || 0) + (m.outputPer1M || 0) : 0; };
  const baseRate = rate(baselineModel);
  const prodSum = sum(items, (i) => i.productionCost);
  if (!baseRate || !prodSum) return items.length * 0.02; // fallback: ~2c/item
  const candFactor = rate(candidateModel) / baseRate;
  const judgeFactor = judgeModel ? rate(judgeModel) / baseRate : 0;
  return prodSum * (candFactor + judgeFactor);
}

// Kick off a run in the background. Validates cost ceiling up front. Returns the created EvalRun.
async function startRun({ rec, dataset, judgeModel, thresholds, maxRunCostUsd = null, createdBy = "console" }) {
  const items = await EvalItem.find({ datasetId: dataset._id }).lean();
  const estimatedCostUsd = estimateRunCost(items, dataset.baselineModel, dataset.candidateModel, judgeModel);

  const run = await EvalRun.create({
    recommendationId: rec ? rec._id : null,
    datasetId: dataset._id,
    application: dataset.scope?.application || null,
    workflow: dataset.scope?.workflow || null,
    taskType: dataset.scope?.taskType || null,
    baselineModel: dataset.baselineModel,
    candidateModel: dataset.candidateModel,
    judgeModel: judgeModel || null,
    riskTier: dataset.riskTier,
    thresholds,
    estimatedCostUsd,
    maxRunCostUsd,
    status: "queued",
    createdBy,
  });

  if (maxRunCostUsd != null && estimatedCostUsd > maxRunCostUsd) {
    run.status = "failed";
    run.error = `estimated cost $${estimatedCostUsd.toFixed(2)} exceeds cap $${Number(maxRunCostUsd).toFixed(2)}`;
    run.completedAt = new Date();
    await run.save();
    return run;
  }
  if (rec) { rec.evalStatus = "running"; rec.evalRunId = run._id; await rec.save().catch(() => {}); }

  // Fire-and-forget; the run updates its own status.
  setImmediate(() => executeRun(run._id).catch((e) => console.error("[eval-replay] run failed:", e.message)));
  return run;
}

async function executeRun(runId) {
  const run = await EvalRun.findById(runId);
  if (!run || run.status !== "queued") return;
  const dataset = await EvalDataset.findById(run.datasetId);
  const items = await EvalItem.find({ datasetId: run.datasetId }).lean();
  const { router, eff } = await getRouter().catch(() => ({}));

  run.status = "running";
  run.startedAt = new Date();
  await run.save();

  if (!router || !eff) return finish(run, [], "no live provider/router (demo mode); cannot replay");

  const settings = await require("../models/Settings").get().catch(() => ({}));
  const maskEnabled = !!settings.piiMaskingEnabled;
  const customPatterns = settings.customPiiPatterns || [];
  const cm = pricing.getModel(dataset.candidateModel);
  if (!cm || !eff.liveIds.includes(cm.provider)) {
    return finish(run, [], `candidate model "${dataset.candidateModel}" is not on a live provider`);
  }

  const entries = [];
  let actualCost = 0;
  for (const item of items) {
    if (!item.messages) { // metadata_only dataset — nothing to replay
      entries.push({ errored: true });
      continue;
    }
    if (run.maxRunCostUsd != null && actualCost > run.maxRunCostUsd) {
      run.error = `cost cap $${run.maxRunCostUsd} reached after ${entries.length} items; stopped early`;
      break;
    }
    try {
      const candidate = await router.complete({
        messages: item.messages, providerOverride: cm.provider, modelOverride: dataset.candidateModel,
      });
      const candCost = pricing.costFor(dataset.candidateModel, candidate.usage?.inputTokens || 0, candidate.usage?.outputTokens || 0).totalCost;
      actualCost += candCost;
      const { formatPass, results } = runValidators(candidate.text, item.validators);
      const flip = Math.random() < 0.5; // A/B position de-bias
      const verdict = await judgeItem({
        router, eff, judgeModel: run.judgeModel,
        userText: lastUserText(item.messages), baselineText: item.productionResponse, candidateText: candidate.text, flip,
      });

      const storedResp = clampText(maskEnabled ? maskPii(candidate.text || "", customPatterns) : (candidate.text || ""));
      await EvalResult.create({
        evalRunId: run._id, evalItemId: item._id, requestId: item.requestId,
        baselineModel: dataset.baselineModel, candidateModel: dataset.candidateModel,
        candidateResponse: storedResp, candidateCost: candCost, candidateLatencyMs: candidate.latencyMs || 0,
        judgeVerdict: verdict ? verdict.verdict : null,
        dimensionScores: verdict ? verdict.dimensionScores : {},
        criticalFailure: verdict ? !!verdict.criticalFailure : false,
        validatorResults: results, formatPass,
        abFlipped: verdict ? !!verdict.abFlipped : false,
        judgeRationale: verdict ? verdict.judgeRationale : null,
      });
      entries.push({
        verdict: verdict ? verdict.verdict : null,
        criticalFailure: verdict ? !!verdict.criticalFailure : false,
        formatPass, candidateCost: candCost, candidateLatencyMs: candidate.latencyMs || 0,
        productionCost: item.productionCost || 0, productionLatencyMs: item.productionLatencyMs || 0,
        errored: false,
      });
    } catch (err) {
      await EvalResult.create({
        evalRunId: run._id, evalItemId: item._id, requestId: item.requestId,
        baselineModel: dataset.baselineModel, candidateModel: dataset.candidateModel, error: err.message,
      });
      entries.push({ errored: true });
    }
  }
  return finish(run, entries, null, actualCost);
}

async function finish(run, entries, hardError, actualCost = 0) {
  const summary = aggregate(entries);
  run.summary = summary;
  run.actualCostUsd = actualCost;
  run.completedAt = new Date();
  if (hardError) {
    run.status = "failed";
    run.error = hardError;
    run.failures = [hardError];
  } else {
    const { passed, failures } = evaluateRun(summary, run.thresholds || {});
    run.status = passed ? "passed" : "failed";
    run.failures = failures;
  }
  await run.save();

  if (run.recommendationId) {
    const rec = await Recommendation.findById(run.recommendationId).catch(() => null);
    if (rec) {
      rec.evalStatus = run.status === "passed" ? "passed" : "failed";
      rec.evalRunId = run._id;
      rec.qualitySummary = summary;
      await rec.save().catch(() => {});
    }
  }
  return run;
}

module.exports = { startRun, executeRun, aggregate, estimateRunCost };
