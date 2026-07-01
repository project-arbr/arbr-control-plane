// One shadow-eval observation: the prod response (actually served) paired with the
// candidate response (mirrored, never served) for the same request, plus the judge verdict.
// Prompt/responses are PII-masked at write time (same as RequestRecord) and size-capped.
const mongoose = require("mongoose");

const evalPairSchema = new mongoose.Schema(
  {
    campaignId: { type: mongoose.Schema.Types.ObjectId, ref: "EvalCampaign", required: true, index: true },
    requestId:  { type: String, index: true },
    timestamp:  { type: Date, default: Date.now, index: true },
    application: { type: String, index: true },
    taskType:   { type: String },

    // Prod (served)
    prodModel:      { type: String },
    prodProvider:   { type: String },
    prodCost:       { type: Number, default: 0 },
    prodLatencyMs:  { type: Number, default: 0 },
    prodResponse:   { type: String, default: null },

    // Candidate (mirrored, not served)
    candidateModel:     { type: String },
    candidateProvider:  { type: String },
    candidateCost:      { type: Number, default: 0 },
    candidateLatencyMs: { type: Number, default: 0 },
    candidateResponse:  { type: String, default: null },

    // Judge verdict, from the candidate's perspective vs prod. null = not yet judged.
    verdict:   { type: String, enum: ["better", "equal", "worse", null], default: null, index: true },
    rationale: { type: String, default: null },
    judgeModel: { type: String, default: null },

    messages:  { type: mongoose.Schema.Types.Mixed, default: null }, // request payload (masked)
  },
  { collection: "eval_pairs" }
);

module.exports = mongoose.model("EvalPair", evalPairSchema);
