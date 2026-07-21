// An immutable historical sample of production requests, used for offline replay of a
// candidate model. Built from RequestRecord by a recommendation's scope. Because it copies
// prompts/responses out of request_records, it is covered by the same retention purge and
// masking rules (see maintenance/purge.js and piiMode below).
const mongoose = require("mongoose");

const evalDatasetSchema = new mongoose.Schema(
  {
    name: { type: String, default: "" },
    // A benchmark is a NAMED, REUSABLE dataset: candidateModel is null (each candidate is chosen
    // per run), and many EvalRuns reference it so models are scored against the same frozen set.
    // Ephemeral one-shot eval datasets have isBenchmark=false.
    isBenchmark: { type: Boolean, default: false, index: true },
    recommendationId: { type: mongoose.Schema.Types.ObjectId, ref: "Recommendation", default: null, index: true },
    scope: {
      application: { type: String, default: null },
      workflow: { type: String, default: null },
      taskType: { type: String, default: null },
      currentModel: { type: String, default: null },
      department: { type: String, default: null },
      difficulty: { type: String, default: null },
    },
    baselineModel: { type: String, default: null },  // the model to beat (current)
    candidateModel: { type: String, default: null }, // the cheaper model under test
    sourceWindow: { from: { type: Date, default: null }, to: { type: Date, default: null } },
    sampling: {
      method: { type: String, default: "stratified" },
      targetCount: { type: Number, default: 0 },
      dedupeByPromptHash: { type: Boolean, default: true },
    },
    riskTier: { type: String, enum: ["low", "medium", "high"], default: "medium" },
    // How prompts/responses are stored: masked (PII-redacted), metadata_only (no text), or
    // raw_allowed (only when an operator explicitly permits it).
    piiMode: { type: String, enum: ["masked", "metadata_only", "raw_allowed"], default: "masked" },
    itemCount: { type: Number, default: 0 },
    status: { type: String, enum: ["creating", "ready", "failed"], default: "creating", index: true },
    error: { type: String, default: null },
    createdBy: { type: String, default: "console" },
    // F-06: propagated from a fixture-owned Recommendation at create-eval-dataset time. Lets
    // the run-eval demo short-circuit recognize this dataset, and `npm run demo:reset` clean it up.
    isDemoFixture: { type: Boolean, default: false, index: true },
  },
  { collection: "eval_datasets", timestamps: true }
);

module.exports = mongoose.model("EvalDataset", evalDatasetSchema);
