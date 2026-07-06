// Auto-rollback monitor for active canary experiments. Every 5 minutes it recomputes each
// experiment's live metrics over its window and rolls back on any guardrail breach. Pure
// guardrail evaluation is separated for unit tests. Same single-process caveat as the budget
// cache and errorAlertMonitor: it is a timer, not a hard real-time guarantee.
const RequestRecord = require("../models/RequestRecord");
const RoutingExperiment = require("../models/RoutingExperiment");
const EvalPair = require("../models/EvalPair");
const Settings = require("../models/Settings");
const canaryEngine = require("./canaryEngine");

const INTERVAL_MS = 5 * 60 * 1000;
let _timer = null;

function pct(n) { return n == null || isNaN(n) ? "n/a" : `${(n * 100).toFixed(1)}%`; }

function p95(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(0.95 * s.length))];
}

// Decide rollback from computed metrics. Pure. Returns { breached, reasons, insufficient }.
function evaluateGuardrails(m, g, minSample) {
  if ((m.candTotal || 0) < (minSample || 0)) return { breached: false, reasons: [], insufficient: true };
  const reasons = [];
  const errInc = (m.candErrorRate || 0) - (m.baseErrorRate || 0);
  if (g.maxErrorRateIncrease != null && errInc > g.maxErrorRateIncrease) {
    reasons.push(`error rate +${pct(errInc)} vs baseline (max +${pct(g.maxErrorRateIncrease)})`);
  }
  if (g.maxLatencyRegressionPct != null && m.latencyRegressionPct != null && m.latencyRegressionPct > g.maxLatencyRegressionPct) {
    reasons.push(`p95 latency regressed ${pct(m.latencyRegressionPct)} (max ${pct(g.maxLatencyRegressionPct)})`);
  }
  if (g.minCostSavingPct != null && m.costSavingPct != null && m.costSavingPct < g.minCostSavingPct) {
    reasons.push(`cost saving ${pct(m.costSavingPct)} below floor ${pct(g.minCostSavingPct)}`);
  }
  if (g.maxWorseRate != null && m.worseRate != null && m.worseRate > g.maxWorseRate) {
    reasons.push(`shadow worse-rate ${pct(m.worseRate)} exceeds ${pct(g.maxWorseRate)}`);
  }
  return { breached: reasons.length > 0, reasons, insufficient: false };
}

// Compute candidate-vs-baseline metrics for an experiment over its window.
async function metricsFor(exp) {
  const since = new Date(Date.now() - (exp.metricsWindowMinutes || 60) * 60000);
  const scope = {};
  if (exp.scope?.application) scope.application = exp.scope.application;
  if (exp.scope?.workflow) scope.workflow = exp.scope.workflow;
  if (exp.scope?.taskType) scope.taskType = exp.scope.taskType;
  const proj = { status: 1, totalCost: 1, latencyMs: 1 };

  const cand = await RequestRecord.find({ ...scope, timestamp: { $gte: since }, routingDecision: "canary", model: exp.candidateModel }, proj).lean();
  const base = await RequestRecord.find({ ...scope, timestamp: { $gte: since }, routingDecision: { $ne: "canary" }, model: exp.baselineModel }, proj).lean();

  const stats = (rows) => {
    const total = rows.length;
    const failures = rows.filter((r) => r.status === "failure").length;
    const ok = rows.filter((r) => r.status === "success");
    const avgCost = ok.length ? ok.reduce((a, r) => a + (r.totalCost || 0), 0) / ok.length : 0;
    return { total, errorRate: total ? failures / total : 0, avgCost, p95: p95(ok.map((r) => r.latencyMs || 0)) };
  };
  const c = stats(cand), b = stats(base);

  let worseRate = null;
  if (exp.shadowCampaignId) {
    const judged = await EvalPair.find({ campaignId: exp.shadowCampaignId, verdict: { $ne: null } }, { verdict: 1 }).lean();
    if (judged.length) worseRate = judged.filter((p) => p.verdict === "worse").length / judged.length;
  }
  return {
    candTotal: c.total, baseTotal: b.total,
    candErrorRate: c.errorRate, baseErrorRate: b.errorRate,
    latencyRegressionPct: b.p95 > 0 ? (c.p95 - b.p95) / b.p95 : null,
    costSavingPct: b.avgCost > 0 ? (b.avgCost - c.avgCost) / b.avgCost : null,
    worseRate,
  };
}

async function rollback(exp, reasons) {
  await RoutingExperiment.updateOne({ _id: exp._id }, { $set: {
    status: "rolled_back", rollbackReason: reasons.join("; "), lastMonitoredAt: new Date(),
  } });
  canaryEngine.invalidate();
  const s = await Settings.get().catch(() => null);
  if (s?.webhookUrl) {
    fetch(s.webhookUrl, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "canary_rolled_back", experimentId: String(exp._id),
        candidateModel: exp.candidateModel, baselineModel: exp.baselineModel, reasons }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
  }
}

async function check() {
  try {
    const experiments = await RoutingExperiment.find({ status: "active" }).lean();
    for (const exp of experiments) {
      const m = await metricsFor(exp);
      const verdict = evaluateGuardrails(m, exp.guardrails || {}, exp.minSampleForRollback);
      await RoutingExperiment.updateOne({ _id: exp._id }, { $set: { lastMonitoredAt: new Date(), lastMetrics: m } });
      if (verdict.breached) await rollback(exp, verdict.reasons);
    }
  } catch { /* must not crash the process */ }
}

function start() {
  if (_timer) return;
  _timer = setInterval(check, INTERVAL_MS);
  if (_timer.unref) _timer.unref();
}
function stop() { if (_timer) { clearInterval(_timer); _timer = null; } }

module.exports = { start, stop, check, evaluateGuardrails, metricsFor };
