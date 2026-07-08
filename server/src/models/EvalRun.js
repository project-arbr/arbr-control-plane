// One offline evaluation of one candidate model against one baseline over a dataset. Holds
// the thresholds it was judged against, a cost ceiling, and the aggregated summary. Its
// terminal status (passed/failed) is what gates a recommendation into an enabled rule.
const mongoose = require("mongoose");

const evalRunSchema = new mongoose.Schema(
  {
    recommendationId: { type: mongoose.Schema.Types.ObjectId, ref: "Recommendation", default: null, index: true },
    datasetId: { type: mongoose.Schema.Types.ObjectId, ref: "EvalDataset", required: true, index: true },
    application: { type: String, default: null },
    workflow: { type: String, default: null },
    taskType: { type: String, default: null },
    baselineModel: { type: String, default: null },
    candidateModel: { type: String, default: null },
    judgeModel: { type: String, default: null },
    riskTier: { type: String, enum: ["low", "medium", "high"], default: "medium" },
    // Eval fidelity, derived from the dataset's piiMode. A "masked" run compares the candidate on
    // redacted prompts against a baseline answer produced from the ORIGINAL prompt, so it is not
    // strictly apples-to-apples — treat a masked pass as lower-confidence than a "high" (raw) one.
    fidelity: { type: String, enum: ["high", "masked", "metadata_only"], default: "high" },

    status: { type: String, enum: ["queued", "running", "passed", "failed", "cancelled"], default: "queued", index: true },
    thresholds: { type: mongoose.Schema.Types.Mixed, default: null },

    // Exploratory (manually-created) run: the sample-size floor was lowered to the traffic
    // actually available instead of the risk-tier promotion floor. A pass is a directional
    // signal on a small sample, NOT a promotion-grade result. The UI labels it as such.
    exploratory: { type: Boolean, default: false },

    // "Disprove it" precision pass: re-examine every "worse" verdict and drop the ones that don't
    // survive falsification (judge noise). On by default; the count of overturned verdicts is in
    // summary.disprovedWorse.
    disprovePass: { type: Boolean, default: true },

    // Cost guardrail — replay + judge calls are real spend. Estimated up front; the run aborts
    // (status:failed) rather than exceed maxRunCostUsd.
    estimatedCostUsd: { type: Number, default: 0 },
    maxRunCostUsd: { type: Number, default: null },
    actualCostUsd: { type: Number, default: 0 },

    summary: { type: mongoose.Schema.Types.Mixed, default: null },
    failures: { type: [String], default: [] }, // why it failed thresholds (empty when passed)
    error: { type: String, default: null },

    createdBy: { type: String, default: "console" },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
  },
  { collection: "eval_runs", timestamps: true }
);

module.exports = mongoose.model("EvalRun", evalRunSchema);
