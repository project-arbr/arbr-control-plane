// Cross-replica dedup for outbound webhook notifications. A successful insert
// means "this call is the sender"; a duplicate-key error means another
// replica (or an earlier request on this one) already claimed the key within
// the window. Self-expires via the TTL index, so no manual pruning is needed.
const mongoose = require("mongoose");

const DEDUP_WINDOW_SECONDS = 5 * 60;

const notificationDedupSchema = new mongoose.Schema(
  {
    dedupKey: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { collection: "notification_dedups" }
);

notificationDedupSchema.index({ dedupKey: 1 }, { unique: true });
notificationDedupSchema.index({ createdAt: 1 }, { expireAfterSeconds: DEDUP_WINDOW_SECONDS });

module.exports = mongoose.model("NotificationDedup", notificationDedupSchema);
