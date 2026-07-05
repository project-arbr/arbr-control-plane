// One prompt/input sampled from historical traffic, frozen for replay. Text fields honor the
// parent dataset's piiMode (masked / omitted for metadata_only). Deleted with the dataset and
// by the retention purge.
const mongoose = require("mongoose");

const evalItemSchema = new mongoose.Schema(
  {
    datasetId: { type: mongoose.Schema.Types.ObjectId, ref: "EvalDataset", required: true, index: true },
    requestId: { type: String, default: null },
    application: { type: String, default: null },
    workflow: { type: String, default: null },
    taskType: { type: String, default: null },
    currentModel: { type: String, default: null }, // baseline model that served it in prod

    messages: { type: mongoose.Schema.Types.Mixed, default: null }, // input (masked unless raw allowed; null for metadata_only)
    productionResponse: { type: String, default: null },
    productionCost: { type: Number, default: 0 },
    productionLatencyMs: { type: Number, default: 0 },

    promptHash: { type: String, default: null, index: true },
    responseHash: { type: String, default: null },

    // Optional per-item output validators (json_schema | regex | contains | classification_label).
    validators: { type: [mongoose.Schema.Types.Mixed], default: [] },
    metadata: {
      classifiedBy: { type: String, default: null },
      difficulty: { type: String, default: null },
      confidence: { type: Number, default: null },
    },
  },
  { collection: "eval_items", timestamps: true }
);

module.exports = mongoose.model("EvalItem", evalItemSchema);
