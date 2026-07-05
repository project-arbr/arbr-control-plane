// The per-item outcome of an eval run: the candidate's response, its cost/latency, the judge
// verdict + rubric scores, and validator results. Powers the "worst examples" evidence view.
const mongoose = require("mongoose");

const evalResultSchema = new mongoose.Schema(
  {
    evalRunId: { type: mongoose.Schema.Types.ObjectId, ref: "EvalRun", required: true, index: true },
    evalItemId: { type: mongoose.Schema.Types.ObjectId, ref: "EvalItem", default: null },
    requestId: { type: String, default: null },
    baselineModel: { type: String, default: null },
    candidateModel: { type: String, default: null },

    candidateResponse: { type: String, default: null }, // stored per dataset piiMode
    candidateCost: { type: Number, default: 0 },
    candidateLatencyMs: { type: Number, default: 0 },

    judgeVerdict: { type: String, enum: ["better", "equal", "worse", null], default: null },
    dimensionScores: {
      correctness: { type: Number, default: null },
      completeness: { type: Number, default: null },
      instructionFollowing: { type: Number, default: null },
      format: { type: Number, default: null },
      safety: { type: Number, default: null },
    },
    criticalFailure: { type: Boolean, default: false },
    validatorResults: { type: [mongoose.Schema.Types.Mixed], default: [] },
    formatPass: { type: Boolean, default: true },
    abFlipped: { type: Boolean, default: false }, // candidate was placed in slot A this item
    judgeRationale: { type: String, default: null },
    error: { type: String, default: null }, // candidate/judge call error, if any
  },
  { collection: "eval_results", timestamps: true }
);

module.exports = mongoose.model("EvalResult", evalResultSchema);
