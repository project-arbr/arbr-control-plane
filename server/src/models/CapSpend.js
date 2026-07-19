// Per-cap atomic spend counters for hard budget enforcement.
// Multi-replica safe via Mongo $inc — the gateway hot path reads this, not a
// 30s-stale aggregation cache. Analytics.spend remains the source of truth for
// dashboards; reconcile() realigns counters periodically.
const mongoose = require("mongoose");

const capSpendSchema = new mongoose.Schema(
  {
    capId: { type: mongoose.Schema.Types.ObjectId, ref: "Cap", required: true, index: true },
    // "day:YYYY-MM-DD" or "month:YYYY-MM"
    windowKey: { type: String, required: true },
    spent: { type: Number, default: 0 },
    updatedAt: { type: Date, default: Date.now },
  },
  { collection: "cap_spends" }
);

capSpendSchema.index({ capId: 1, windowKey: 1 }, { unique: true });

module.exports = mongoose.model("CapSpend", capSpendSchema);
