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
    // A human's overriding verdict for this item (ground truth). When set, it beats the judge in
    // scoring: the effective verdict = humanVerdict ?? judgeVerdict, and the run is re-scored.
    humanVerdict: { type: String, enum: ["better", "equal", "worse", null], default: null },
    // The judge's FIRST-pass verdict, kept when the "disprove it" pass overturned a "worse" call.
    preDisproveVerdict: { type: String, enum: ["better", "equal", "worse", null], default: null },
    disproved: { type: Boolean, default: false }, // a "worse" verdict was overturned on falsification
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

    // F-06: true for synthetic per-item rows generated alongside a demo-fixture EvalRun.
    // candidateResponse/judgeRationale are never real text for these — see eval/demoFixture.js.
    isDemoFixture: { type: Boolean, default: false, index: true },
  },
  { collection: "eval_results", timestamps: true }
);

module.exports = mongoose.model("EvalResult", evalResultSchema);
