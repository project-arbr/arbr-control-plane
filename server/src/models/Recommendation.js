// An advisory, costed optimisation suggestion produced from the logged data.
// A person accepts it (→ creates a disabled rule) or dismisses it.
const mongoose = require("mongoose");

const recommendationSchema = new mongoose.Schema(
  {
    type: { type: String, default: "premium_model_overuse", index: true },
    title: { type: String, required: true },
    reason: { type: String, required: true },

    // What the recommendation is about. Scope narrows where an accepted rule applies; null = any.
    // (Today's engine produces task-type-global recs; these let accept constrain the rule and
    // leave room for per-application recommendations without another schema change.)
    application: { type: String, default: null },
    workflow: { type: String, default: null },
    department: { type: String, default: null },
    taskType: { type: String, default: null },
    currentModel: { type: String, default: null },
    currentProvider: { type: String, default: null },
    suggestedModel: { type: String, default: null },
    suggestedProvider: { type: String, default: null },

    // Evidence + projection (USD over the analysed window).
    requestCount: { type: Number, default: 0 },
    // How many of those requests an eval could actually replay (captured prompt+response,
    // non-cache). 0 = the recommendation predates payload capture; the eval can't run on it.
    replayableCount: { type: Number, default: null },
    currentCost: { type: Number, default: 0 },
    projectedCost: { type: Number, default: 0 },
    projectedSavings: { type: Number, default: 0 },

    status: {
      type: String,
      enum: ["pending", "accepted", "dismissed"],
      default: "pending",
      index: true,
    },

    // Eval gating (P0): a recommendation cannot become an ENABLED rule until it has passed an
    // offline eval, or an admin overrides. See eval/thresholds.gateAccept + eval/replay.
    evalStatus: {
      type: String,
      enum: ["not_started", "dataset_ready", "running", "passed", "failed", "overridden"],
      default: "not_started",
      index: true,
    },
    evalDatasetId: { type: mongoose.Schema.Types.ObjectId, ref: "EvalDataset", default: null },
    evalRunId: { type: mongoose.Schema.Types.ObjectId, ref: "EvalRun", default: null },
    shadowCampaignId: { type: mongoose.Schema.Types.ObjectId, ref: "EvalCampaign", default: null }, // Phase 2
    experimentId: { type: mongoose.Schema.Types.ObjectId, ref: "RoutingExperiment", default: null }, // Phase 3 canary
    qualitySummary: { type: mongoose.Schema.Types.Mixed, default: null }, // last run's summary
    override: {
      reason: { type: String, default: null },
      approver: { type: String, default: null },
      at: { type: Date, default: null },
      expiresAt: { type: Date, default: null },
    },

    // Stable key so re-running the engine updates instead of duplicating.
    dedupeKey: { type: String, unique: true, index: true },
  },
  { collection: "recommendations", timestamps: true }
);

module.exports = mongoose.model("Recommendation", recommendationSchema);
