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
const { judgeItem, disproveWorse, runValidators, lastUserText } = require("./rubricJudge");
const { evaluateRun } = require("./thresholds");

// Curation weights for the severity-weighted worse-rate. "normal" = 1 so uncurated benchmarks are
// unchanged; a critical regression counts 3x, a trivial one 0.3x.
const SEVERITY_WEIGHT = { trivial: 0.3, normal: 1, critical: 3 };

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
  const disprovedWorse = ok.filter((e) => e.disproved).length; // "worse" calls overturned on falsification

  // Severity-weighted worse-rate: a critical miss counts more than a trivial one. Uniform "normal"
  // severity → identical to the raw rate, so uncurated benchmarks are unaffected.
  const wt = (e) => SEVERITY_WEIGHT[e.severity] ?? 1;
  const judgedWeight = sum(judged, wt);
  const worseWeight = sum(judged.filter((e) => e.verdict === "worse"), wt);
  const worseRateWeighted = judgedWeight ? worseWeight / judgedWeight : 0;
  const severityBreakdown = {};
  for (const sev of Object.keys(SEVERITY_WEIGHT)) {
    const g = judged.filter((e) => (e.severity || "normal") === sev);
    if (g.length) severityBreakdown[sev] = { judged: g.length, worse: g.filter((e) => e.verdict === "worse").length };
  }

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
    // worseRate is the severity-WEIGHTED rate (drives the gate); worseRateRaw is the plain count.
    worseRate: worseRateWeighted,
    worseRateRaw: judged.length ? worse / judged.length : 0,
    severityBreakdown,
    disprovedWorse,
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
async function startRun({ rec, dataset, judgeModel, thresholds, maxRunCostUsd = null, createdBy = "console", exploratory = false, candidateModel = null }) {
  // The candidate can be supplied per-run (a reusable benchmark tests many candidates against one
  // frozen set); it falls back to the dataset's own candidate for the classic one-shot eval.
  const candidate = candidateModel || dataset.candidateModel;
  const items = await EvalItem.find({ datasetId: dataset._id }).lean();
  const estimatedCostUsd = estimateRunCost(items, dataset.baselineModel, candidate, judgeModel);

  const run = await EvalRun.create({
    recommendationId: rec ? rec._id : null,
    exploratory: !!exploratory,
    datasetId: dataset._id,
    application: dataset.scope?.application || null,
    workflow: dataset.scope?.workflow || null,
    taskType: dataset.scope?.taskType || null,
    baselineModel: dataset.baselineModel,
    candidateModel: candidate,
    judgeModel: judgeModel || null,
    riskTier: dataset.riskTier,
    fidelity: dataset.piiMode === "raw_allowed" ? "high" : (dataset.piiMode === "metadata_only" ? "metadata_only" : "masked"),
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

  // The run stays "queued"; the eval worker (eval/worker.js) claims and executes it. This
  // survives a process restart (a queued run is picked up on next boot) instead of being lost
  // with an in-process setImmediate.
  return run;
}

async function executeRun(runId) {
  // Atomically claim the run (queued → running) so concurrent workers can't double-execute it.
  const run = await EvalRun.findOneAndUpdate(
    { _id: runId, status: "queued" },
    { $set: { status: "running", startedAt: new Date() } },
    { new: true }
  );
  if (!run) return; // already claimed, cancelled, or gone
  const dataset = await EvalDataset.findById(run.datasetId);
  const items = await EvalItem.find({ datasetId: run.datasetId }).lean();
  const { router, eff } = await getRouter().catch(() => ({}));

  if (!router || !eff) return finish(run, [], "no live provider/router (demo mode); cannot replay");

  const settings = await require("../models/Settings").get().catch(() => ({}));
  const maskEnabled = !!settings.piiMaskingEnabled;
  const customPatterns = settings.customPiiPatterns || [];
  const cm = pricing.getModel(run.candidateModel);
  if (!cm || !eff.liveIds.includes(cm.provider)) {
    return finish(run, [], `candidate model "${run.candidateModel}" is not on a live provider`);
  }

  const entries = [];
  let actualCost = 0;
  let cancelled = false;
  for (const item of items) {
    if (!item.messages) { // metadata_only dataset — nothing to replay
      entries.push({ errored: true });
      continue;
    }
    if (run.maxRunCostUsd != null && actualCost > run.maxRunCostUsd) {
      run.error = `cost cap $${run.maxRunCostUsd} reached after ${entries.length} items; stopped early`;
      break;
    }
    // Honor cancellation mid-run (checked periodically to bound DB reads).
    if (entries.length % 10 === 0) {
      const fresh = await EvalRun.findById(run._id, { status: 1 }).lean().catch(() => null);
      if (fresh && fresh.status === "cancelled") { cancelled = true; break; }
    }
    try {
      const candidate = await router.complete({
        messages: item.messages, providerOverride: cm.provider, modelOverride: run.candidateModel,
      });
      const candCost = pricing.costFor(run.candidateModel, candidate.usage?.inputTokens || 0, candidate.usage?.outputTokens || 0).totalCost;
      actualCost += candCost;
      const { formatPass, results } = runValidators(candidate.text, item.validators);
      const flip = Math.random() < 0.5; // A/B position de-bias
      const verdict = await judgeItem({
        router, eff, judgeModel: run.judgeModel,
        userText: lastUserText(item.messages), baselineText: item.productionResponse, candidateText: candidate.text, flip,
      });
      // { error } = judge was configured but produced no usable verdict (call failed / bad output).
      const judgeError = verdict && verdict.error ? verdict.error : null;
      const scored = verdict && !judgeError ? verdict : null;

      // "Disprove it": re-examine a "worse" verdict; drop it if it doesn't survive falsification.
      let finalVerdict = scored ? scored.verdict : null;
      let disproved = false;
      let disproveReason = null;
      if (scored && scored.verdict === "worse" && run.disprovePass !== false) {
        const dp = await disproveWorse({
          router, eff, judgeModel: run.judgeModel,
          userText: lastUserText(item.messages), baselineText: item.productionResponse, candidateText: candidate.text,
        });
        if (dp.overturned) { finalVerdict = "equal"; disproved = true; disproveReason = dp.reason; }
      }

      const storedResp = clampText(maskEnabled ? maskPii(candidate.text || "", customPatterns) : (candidate.text || ""));
      await EvalResult.create({
        evalRunId: run._id, evalItemId: item._id, requestId: item.requestId,
        baselineModel: dataset.baselineModel, candidateModel: run.candidateModel,
        candidateResponse: storedResp, candidateCost: candCost, candidateLatencyMs: candidate.latencyMs || 0,
        judgeVerdict: finalVerdict,
        preDisproveVerdict: scored ? scored.verdict : null,
        disproved,
        dimensionScores: scored ? scored.dimensionScores : {},
        criticalFailure: scored ? !!scored.criticalFailure : false,
        validatorResults: results, formatPass,
        abFlipped: scored ? !!scored.abFlipped : false,
        judgeRationale: disproved ? `[disprove pass overturned "worse"] ${disproveReason || ""}`.trim() : (scored ? scored.judgeRationale : judgeError),
      });
      entries.push({
        verdict: finalVerdict,
        severity: item.severity || "normal",
        criticalFailure: scored ? !!scored.criticalFailure : false,
        formatPass, candidateCost: candCost, candidateLatencyMs: candidate.latencyMs || 0,
        productionCost: item.productionCost || 0, productionLatencyMs: item.productionLatencyMs || 0,
        errored: false, judgeError, disproved,
      });
    } catch (err) {
      await EvalResult.create({
        evalRunId: run._id, evalItemId: item._id, requestId: item.requestId,
        baselineModel: dataset.baselineModel, candidateModel: run.candidateModel, error: err.message,
      });
      entries.push({ errored: true });
    }
  }
  return finish(run, entries, cancelled ? "__cancelled__" : null, actualCost);
}

async function finish(run, entries, hardError, actualCost = 0) {
  const summary = aggregate(entries);
  run.summary = summary;
  run.actualCostUsd = actualCost;
  run.completedAt = new Date();
  if (hardError === "__cancelled__") {
    run.status = "cancelled";
    run.error = "cancelled mid-run";
    run.failures = [];
  } else if (hardError) {
    run.status = "failed";
    run.error = hardError;
    run.failures = [hardError];
  } else {
    const { passed, failures } = evaluateRun(summary, run.thresholds || {});
    run.status = passed ? "passed" : "failed";
    run.failures = failures;
    // If nothing got judged because the JUDGE itself failed, say so — otherwise "0 items judged"
    // looks like a data problem when it's really a bad/unreachable judge model.
    const judgeErrs = entries.filter((e) => e.judgeError);
    if ((summary.judged || 0) === 0 && judgeErrs.length) {
      run.error = `The judge produced no verdicts: ${judgeErrs[judgeErrs.length - 1].judgeError}. ` +
        `Pick a judge on a connected provider that reliably returns JSON (e.g. gpt-4o-mini).`;
    }
  }
  await run.save();

  if (run.recommendationId) {
    const rec = await Recommendation.findById(run.recommendationId).catch(() => null);
    if (rec) {
      // A cancelled run leaves the recommendation re-runnable, not "failed".
      if (run.status === "cancelled") {
        rec.evalStatus = "dataset_ready";
      } else {
        rec.evalStatus = run.status === "passed" ? "passed" : "failed";
        rec.qualitySummary = summary;
      }
      rec.evalRunId = run._id;
      await rec.save().catch(() => {});
    }
  }
  return run;
}

module.exports = { startRun, executeRun, aggregate, estimateRunCost };
