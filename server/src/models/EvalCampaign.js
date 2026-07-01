// A shadow-eval campaign: mirror a sampled fraction of one application's single-shot
// traffic to a candidate model (without serving it), judge candidate-vs-prod, and gate a
// model switch on a healthy verdict. See server/src/eval/shadow.js.
const mongoose = require("mongoose");

const evalCampaignSchema = new mongoose.Schema(
  {
    name:           { type: String, default: "" },
    application:    { type: String, required: true, index: true }, // target app whose traffic is mirrored
    candidateModel: { type: String, required: true },              // model being evaluated
    judgeModel:     { type: String, default: null },               // LLM judge; null = capture pairs only, no verdict
    sampleRate:     { type: Number, default: 0.1, min: 0, max: 1 }, // fraction of eligible requests mirrored
    status:         { type: String, enum: ["active", "paused", "done"], default: "active", index: true },
    // "Safe to switch" gate: notify once pairs >= minPairs AND lossRate <= maxLossRate.
    thresholds:     {
      minPairs:    { type: Number, default: 50 },
      maxLossRate: { type: Number, default: 0.1 },
    },
    notifiedAt:     { type: Date, default: null }, // set when the webhook has fired, so it fires once
    createdBy:      { type: String, default: "console" },
  },
  { timestamps: true, collection: "eval_campaigns" }
);

module.exports = mongoose.model("EvalCampaign", evalCampaignSchema);
