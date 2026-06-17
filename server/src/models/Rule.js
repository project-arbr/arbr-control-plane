// A human-authored, reversible routing rule. Off by default. The gateway
// executes an enabled rule exactly as written — no inference, no quality guess.
const mongoose = require("mongoose");

const ruleSchema = new mongoose.Schema(
  {
    // Condition: match on any combination of these. A field left null = "any".
    condition: {
      taskType: { type: String, default: null },
      application: { type: String, default: null },
      workflow: { type: String, default: null },
    },
    // Target the matched request is routed to.
    target: {
      provider: { type: String, required: true },
      model: { type: String, required: true },
    },
    enabled: { type: Boolean, default: false, index: true },
    createdBy: { type: String, default: "console" },
    // Link back to the recommendation that produced it, if any.
    sourceRecommendation: { type: mongoose.Schema.Types.ObjectId, ref: "Recommendation", default: null },
    note: { type: String, default: "" },
  },
  { collection: "rules", timestamps: true }
);

module.exports = mongoose.model("Rule", ruleSchema);
