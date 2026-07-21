// F-06: design-partner demo fixture support. `eval/replay.js`'s executeRun() and
// `eval/shadow.js`'s maybeShadowEval() both hard-call a live provider with no existing mock
// seam (confirmed by reading every call site — no env var, no Settings flag, no injected
// client). Rather than build a fixture-provider adapter, this module synthesizes a candidate
// eval run WITHOUT ever calling startRun/executeRun/judgeItem: it generates synthetic per-item
// entries and feeds them through the SAME pure, tested functions production uses —
// replay.js's aggregate() and thresholds.js's evaluateRun() — so the demo's pass/fail outcome
// is genuinely computed by production gating logic, not hand-faked numbers.
const EvalRun = require("../models/EvalRun");
const EvalResult = require("../models/EvalResult");
const RequestRecord = require("../models/RequestRecord");
const { aggregate } = require("./replay");
const { riskForTier, targetCountForRisk, defaultThresholds, evaluateRun } = require("./thresholds");
const { tierForTask } = require("../classify/classifier");

// A fresh, deterministic PRNG per call (not a shared module-level counter) — two calls with
// the same seed always produce the same sequence, regardless of what else has run in-process.
// Same LCG shape as seed/seed.js's `rnd()`.
function makeRng(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

// Builds `count` synthetic per-item entries shaped for replay.js's aggregate(). `outcome`
// controls the bias: "pass" clears every risk-tiered threshold; "fail" breaches worse-rate and
// critical-fail-rate specifically (thresholds.js's defaultThresholds always requires BOTH to
// hold, so this is enough to fail regardless of the other stats).
function syntheticEntries(count, outcome, seed = 42) {
  const rnd = makeRng(seed);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const productionCost = 0.01 + rnd() * 0.002;
    const productionLatencyMs = 400 + rnd() * 100;
    let verdict, criticalFailure, formatPass, candidateCost, candidateLatencyMs;
    if (outcome === "fail") {
      verdict = rnd() < 0.4 ? "worse" : rnd() < 0.7 ? "equal" : "better";
      criticalFailure = rnd() < 0.05;
      formatPass = rnd() > 0.1;
      candidateCost = productionCost * (0.5 + rnd() * 0.3);
      candidateLatencyMs = productionLatencyMs * (0.9 + rnd() * 0.3);
    } else {
      verdict = rnd() < 0.003 ? "worse" : rnd() < 0.5 ? "equal" : "better";
      criticalFailure = false;
      formatPass = true;
      candidateCost = productionCost * (0.2 + rnd() * 0.1);
      candidateLatencyMs = productionLatencyMs * (0.7 + rnd() * 0.1);
    }
    entries.push({
      verdict, criticalFailure, formatPass, candidateCost, candidateLatencyMs,
      productionCost, productionLatencyMs, errored: false,
    });
  }
  return entries;
}

// Synthesizes a complete, internally-consistent EvalRun + matching EvalResult batch for a
// demo-fixture recommendation, without ever calling a live provider. `outcome`: "pass"|"fail".
async function synthesizeRun({ rec, dataset, outcome }) {
  const risk = riskForTier(tierForTask(rec.taskType)) || "medium";
  const count = targetCountForRisk(risk);
  const entries = syntheticEntries(count, outcome);
  const summary = aggregate(entries);
  const thresholds = defaultThresholds(risk);
  const { passed, failures } = evaluateRun(summary, thresholds);

  const run = await EvalRun.create({
    recommendationId: rec._id, datasetId: dataset._id,
    application: rec.application, workflow: rec.workflow, taskType: rec.taskType,
    baselineModel: rec.currentModel, candidateModel: rec.suggestedModel,
    riskTier: risk, fidelity: "high",
    status: passed ? "passed" : "failed",
    thresholds, summary, failures,
    isDemoFixture: true,
  });

  await EvalResult.insertMany(entries.map((e, i) => ({
    evalRunId: run._id, requestId: `demo-${rec._id}-${i}`,
    baselineModel: rec.currentModel, candidateModel: rec.suggestedModel,
    candidateResponse: null, // never real text — this is a synthetic demo item
    candidateCost: e.candidateCost, candidateLatencyMs: e.candidateLatencyMs,
    judgeVerdict: e.verdict, criticalFailure: e.criticalFailure, formatPass: e.formatPass,
    judgeRationale: "Synthetic demo item — no live judge call was made.",
    isDemoFixture: true,
  })));

  // Mirror eval/replay.js's finish() side effect on the recommendation exactly, so the
  // dashboard/accept-gate see the same terminal state a real (async) run would leave behind.
  rec.evalStatus = run.status;
  rec.qualitySummary = summary;
  rec.evalRunId = run._id;
  await rec.save();

  return run;
}

// Writes real RequestRecord traffic tagged routingDecision:"canary" (and a matching baseline
// batch) with a deliberately elevated candidate failure rate, so canaryMonitor.js's real
// metricsFor() aggregation would independently reach the same breach conclusion if it ever
// runs against this data — not a disconnected fabricated lastMetrics number.
async function synthesizeCanaryBreach({ rec, experiment, count = 30 }) {
  const rnd = makeRng(99);
  const now = Date.now();
  const windowMs = (experiment.metricsWindowMinutes || 60) * 60 * 1000;
  const rows = [];
  for (let i = 0; i < count; i++) {
    const ts = new Date(now - rnd() * windowMs * 0.8);
    rows.push({
      requestId: `demo-canary-${rec._id}-${i}`, application: rec.application, taskType: rec.taskType,
      provider: rec.suggestedProvider, model: rec.suggestedModel, modelRequested: rec.currentModel,
      status: rnd() < 0.35 ? "failure" : "success", // well above a healthy baseline error rate
      latencyMs: 600 + rnd() * 400, routingDecision: "canary", timestamp: ts,
      totalCost: 0.003 + rnd() * 0.001, isDemoFixture: true,
    });
    rows.push({
      requestId: `demo-baseline-${rec._id}-${i}`, application: rec.application, taskType: rec.taskType,
      provider: rec.currentProvider, model: rec.currentModel, modelRequested: rec.currentModel,
      status: rnd() < 0.02 ? "failure" : "success", // normal baseline error rate
      latencyMs: 400 + rnd() * 100, routingDecision: "auto", timestamp: ts,
      totalCost: 0.01 + rnd() * 0.002, isDemoFixture: true,
    });
  }
  await RequestRecord.insertMany(rows);
}

module.exports = { synthesizeRun, synthesizeCanaryBreach, syntheticEntries };
