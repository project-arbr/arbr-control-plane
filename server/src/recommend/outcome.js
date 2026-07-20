// Approximate "projected vs realised" outcome for a single, LIVE (enabled-rule) recommendation.
//
// Deliberately approximate, per an explicit scoping decision: matches realised traffic by the
// recommendation's own scope fields (application/workflow/taskType) + time since the sourced
// Rule went live, rather than adding a ruleId/recommendationId to RequestRecord. Other traffic
// in the same scope/window would blend in — this imprecision is accepted, and surfaced via the
// `caveat` field below rather than hidden.
//
// Reuses the existing realisedSavings/byModel aggregations verbatim — no new pipelines.
const Rule = require("../models/Rule");
const analytics = require("../analytics/aggregate");

const CAVEAT =
  "Approximate: matched by application/workflow/taskType scope and time since rollout, not a " +
  "direct per-request link to this recommendation. Other traffic in this scope during the " +
  "window is not excluded.";

function scopeOf(rec) {
  const scope = {};
  if (rec.application) scope.application = rec.application;
  if (rec.workflow) scope.workflow = rec.workflow;
  if (rec.taskType) scope.taskType = rec.taskType;
  return scope;
}

async function computeOutcome(rec) {
  const rule = await Rule.findOne({ sourceRecommendation: rec._id, enabled: true }).lean();
  if (!rule) {
    return { live: false, message: "No enabled rule for this recommendation yet — nothing to measure." };
  }

  const liveSince = rule.updatedAt;
  const scope = scopeOf(rec);

  const [realised, candidateRows, baselineRows] = await Promise.all([
    analytics.realisedSavings({ ...scope, from: liveSince.toISOString() }),
    analytics.byModel({ ...scope, model: rec.suggestedModel, from: liveSince.toISOString() }),
    analytics.byModel({ ...scope, model: rec.currentModel, to: liveSince.toISOString() }),
  ]);
  const candidate = candidateRows[0] || null;
  const baseline = baselineRows[0] || null;
  const errRate = (row) => (row && row.requests ? row.failures / row.requests : null);

  return {
    live: true,
    ruleId: rule._id,
    liveSince,
    liveSinceSource:
      "rule.updatedAt (approximate — assumes the enable toggle was the rule's last write)",
    projected: {
      savings: rec.projectedSavings,
      currentCost: rec.currentCost,
      projectedCost: rec.projectedCost,
      requestCount: rec.requestCount,
    },
    realised: {
      savings: realised.totalSaved,
      substitutedRequests: realised.substitutedRequests,
      byQualityGate: realised.byQualityGate,
    },
    latency: {
      baselineAvgMs: baseline?.avgLatency ?? null,
      candidateAvgMs: candidate?.avgLatency ?? null,
      deltaPct: baseline?.avgLatency
        ? ((candidate?.avgLatency ?? 0) - baseline.avgLatency) / baseline.avgLatency
        : null,
    },
    errors: {
      baselineRate: errRate(baseline),
      candidateRate: errRate(candidate),
    },
    sampleSizes: {
      baselineRequests: baseline?.requests ?? 0,
      candidateRequests: candidate?.requests ?? 0,
    },
    caveat: CAVEAT,
  };
}

module.exports = { computeOutcome };
