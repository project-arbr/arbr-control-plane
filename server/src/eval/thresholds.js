// Pure, dependency-free eval gating logic (no mongoose/pricing), so it unit-tests without a DB.
// Risk-tiered thresholds, the pass/fail verdict on a run summary, and the recommendation->rule
// accept gate all live here. Callers pass in the task tier; they own the classifier import.

// Map the classifier's task tier to an eval risk band.
function riskForTier(tier) {
  if (tier === "light") return "low";
  if (tier === "premium") return "high";
  return "medium"; // "mid" / unknown
}

// Default historical sample size per risk band (PRD §13 / FR1).
const TARGET_COUNT = { low: 200, medium: 300, high: 500 };
function targetCountForRisk(risk) {
  return TARGET_COUNT[risk] || TARGET_COUNT.medium;
}

// Risk-tiered pass thresholds. A run PASSES only if every threshold holds.
// worseRate/criticalFailRate: lower is better. formatPassRate/costSavingPct: higher is better.
// latencyRegressionPct: how much slower the candidate may be (0 = must not regress).
const THRESHOLDS = {
  low:    { minItems: 200, maxWorseRate: 0.05, maxCriticalFailRate: 0.005, minFormatPassRate: 0.98,  minCostSavingPct: 0.25, maxLatencyRegressionPct: 0.20 },
  medium: { minItems: 300, maxWorseRate: 0.03, maxCriticalFailRate: 0.002, minFormatPassRate: 0.99,  minCostSavingPct: 0.20, maxLatencyRegressionPct: 0.10 },
  high:   { minItems: 500, maxWorseRate: 0.01, maxCriticalFailRate: 0,     minFormatPassRate: 0.995, minCostSavingPct: 0.15, maxLatencyRegressionPct: 0 },
};
function defaultThresholds(risk) {
  return { ...(THRESHOLDS[risk] || THRESHOLDS.medium) };
}

// High-risk tasks require a human to eyeball at least this many examples before promotion.
const HIGH_RISK_MIN_HUMAN_REVIEW = 50;

// Decide pass/fail from an aggregated run summary against thresholds. Pure.
// Returns { passed, failures: [human-readable reasons] }.
function evaluateRun(summary, thresholds) {
  const s = summary || {};
  const t = thresholds || {};
  const failures = [];
  const judged = Number(s.judged) || 0;

  if (judged < (t.minItems || 0)) {
    failures.push(`only ${judged} items judged, need ${t.minItems}`);
  }
  if (t.maxWorseRate != null && (s.worseRate || 0) > t.maxWorseRate) {
    failures.push(`worse-rate ${pct(s.worseRate)} exceeds ${pct(t.maxWorseRate)}`);
  }
  if (t.maxCriticalFailRate != null && (s.criticalFailRate || 0) > t.maxCriticalFailRate) {
    failures.push(`critical-failure rate ${pct(s.criticalFailRate)} exceeds ${pct(t.maxCriticalFailRate)}`);
  }
  if (t.minFormatPassRate != null && (s.formatPassRate ?? 1) < t.minFormatPassRate) {
    failures.push(`format pass-rate ${pct(s.formatPassRate)} below ${pct(t.minFormatPassRate)}`);
  }
  if (t.minCostSavingPct != null && (s.costSavingPct ?? 0) < t.minCostSavingPct) {
    failures.push(`cost saving ${pct(s.costSavingPct)} below ${pct(t.minCostSavingPct)}`);
  }
  if (t.maxLatencyRegressionPct != null && (s.avgLatencyDeltaPct ?? 0) > t.maxLatencyRegressionPct) {
    failures.push(`latency regressed ${pct(s.avgLatencyDeltaPct)}, max allowed ${pct(t.maxLatencyRegressionPct)}`);
  }
  return { passed: failures.length === 0, failures };
}

// The accept gate: a recommendation may become a rule only when eval passed, or an admin
// supplies a valid, non-expired override. Pure — `now` injected for testability.
// Returns { allowed, status: "passed"|"overridden", reason? }.
function gateAccept(rec, override, now = Date.now()) {
  const evalStatus = rec && rec.evalStatus;
  if (evalStatus === "passed") return { allowed: true, status: "passed" };

  if (override && override.reason && override.approver) {
    if (override.expiresAt && new Date(override.expiresAt).getTime() < now) {
      return { allowed: false, reason: "override has expired" };
    }
    return { allowed: true, status: "overridden" };
  }
  return {
    allowed: false,
    reason:
      `recommendation has not passed evaluation (evalStatus="${evalStatus || "not_started"}"). ` +
      `Run an offline eval first, or accept with an override { reason, approver, expiresAt }.`,
  };
}

function pct(n) {
  if (n == null || isNaN(n)) return "n/a";
  return `${(Number(n) * 100).toFixed(1)}%`;
}

module.exports = {
  riskForTier,
  targetCountForRisk,
  defaultThresholds,
  evaluateRun,
  gateAccept,
  HIGH_RISK_MIN_HUMAN_REVIEW,
  _THRESHOLDS: THRESHOLDS,
};
