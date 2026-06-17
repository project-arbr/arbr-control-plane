// An advisory, costed optimisation suggestion produced from the logged data.
// A person accepts it (→ creates a disabled rule) or dismisses it.
const mongoose = require("mongoose");

const recommendationSchema = new mongoose.Schema(
  {
    type: { type: String, default: "premium_model_overuse", index: true },
    title: { type: String, required: true },
    reason: { type: String, required: true },

    // What the recommendation is about.
    taskType: { type: String, default: null },
    currentModel: { type: String, default: null },
    currentProvider: { type: String, default: null },
    suggestedModel: { type: String, default: null },
    suggestedProvider: { type: String, default: null },

    // Evidence + projection (USD over the analysed window).
    requestCount: { type: Number, default: 0 },
    currentCost: { type: Number, default: 0 },
    projectedCost: { type: Number, default: 0 },
    projectedSavings: { type: Number, default: 0 },

    status: {
      type: String,
      enum: ["pending", "accepted", "dismissed"],
      default: "pending",
      index: true,
    },
    // Stable key so re-running the engine updates instead of duplicating.
    dedupeKey: { type: String, unique: true, index: true },
  },
  { collection: "recommendations", timestamps: true }
);

module.exports = mongoose.model("Recommendation", recommendationSchema);
