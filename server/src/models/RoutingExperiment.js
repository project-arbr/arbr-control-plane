// A controlled canary rollout of an eval-passed candidate model. Only created from a passed
// EvalRun. The gateway routes a deterministic percentage of AUTO-routed traffic (pinned models
// are never touched) to the candidate; a monitor auto-rolls-back on guardrail breach, and an
// admin can promote it to an enabled Rule. See routing/canaryEngine + routing/canaryMonitor.
const mongoose = require("mongoose");

const routingExperimentSchema = new mongoose.Schema(
  {
    evalRunId: { type: mongoose.Schema.Types.ObjectId, ref: "EvalRun", default: null },
    recommendationId: { type: mongoose.Schema.Types.ObjectId, ref: "Recommendation", default: null, index: true },
    shadowCampaignId: { type: mongoose.Schema.Types.ObjectId, ref: "EvalCampaign", default: null }, // for a live worse-rate signal
    ruleId: { type: mongoose.Schema.Types.ObjectId, ref: "Rule", default: null }, // set on promotion

    scope: {
      application: { type: String, default: null, index: true },
      workflow: { type: String, default: null },
      taskType: { type: String, default: null },
    },
    baselineModel: { type: String, required: true },  // the model canary traffic is diverted FROM
    candidateModel: { type: String, required: true }, // routed TO for the canary fraction
    rolloutPct: { type: Number, default: 10, min: 0, max: 100 },

    status: { type: String, enum: ["draft", "active", "paused", "rolled_back", "promoted"], default: "draft", index: true },

    // Auto-rollback fires if any of these is breached over the metrics window.
    guardrails: {
      maxErrorRateIncrease: { type: Number, default: 0.02 },   // candidate error rate minus baseline (absolute)
      maxLatencyRegressionPct: { type: Number, default: 0.25 }, // p95 candidate vs baseline
      maxWorseRate: { type: Number, default: 0.10 },            // from the linked shadow campaign, if any
      minCostSavingPct: { type: Number, default: 0.10 },        // candidate must still save at least this
    },
    metricsWindowMinutes: { type: Number, default: 60 },
    minSampleForRollback: { type: Number, default: 20 }, // don't judge on a handful of requests

    createdBy: { type: String, default: "console" },
    approvedBy: { type: String, default: null },
    rollbackReason: { type: String, default: null },
    lastMonitoredAt: { type: Date, default: null },
    lastMetrics: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { collection: "routing_experiments", timestamps: true }
);

module.exports = mongoose.model("RoutingExperiment", routingExperimentSchema);
