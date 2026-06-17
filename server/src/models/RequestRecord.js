// One record per AI request — the source of every view, report and saving.
// Records BOTH the model requested and the model served (scope p.10) so realised
// savings are measurable and later phases can learn which substitutions held up.
const mongoose = require("mongoose");

const requestRecordSchema = new mongoose.Schema(
  {
    requestId: { type: String, required: true, unique: true, index: true },
    timestamp: { type: Date, required: true, default: Date.now, index: true },

    // who / what
    application: { type: String, index: true },
    workflow: { type: String, index: true },
    userId: { type: String },
    department: { type: String, index: true },

    // model — requested vs actually served
    provider: { type: String, index: true }, // provider served
    model: { type: String, index: true },     // model served
    modelRequested: { type: String, index: true },
    taskType: { type: String, index: true },

    // usage
    promptTokens: { type: Number, default: 0 },
    completionTokens: { type: Number, default: 0 },
    totalTokens: { type: Number, default: 0 },

    // cost (USD)
    inputCost: { type: Number, default: 0 },
    outputCost: { type: Number, default: 0 },
    totalCost: { type: Number, default: 0, index: true },

    // performance + outcome
    latencyMs: { type: Number, default: 0 },
    status: { type: String, enum: ["success", "failure", "blocked"], default: "success", index: true },
    retryCount: { type: Number, default: 0 },

    // routing transparency
    routingDecision: {
      type: String,
      enum: ["passthrough", "explicit", "rule", "auto", "ai", "budget", "cache", "fallback"],
      default: "passthrough",
      index: true,
    },
    // How the taskType was determined: app-provided, keyword heuristic, or AI classifier.
    classifiedBy: { type: String, enum: ["provided", "keyword", "ai"], default: "keyword", index: true },
    cacheHit: { type: Boolean, default: false },
  },
  { collection: "request_records" }
);

module.exports = mongoose.model("RequestRecord", requestRecordSchema);
