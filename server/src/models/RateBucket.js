// Fixed-window request counters for multi-replica RPM enforcement.
// One document per (key, windowStartMs); atomic $inc keeps replicas consistent.
const mongoose = require("mongoose");

const rateBucketSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    // Start of the 60s window (ms since epoch, floored to minute).
    windowStart: { type: Number, required: true },
    count: { type: Number, default: 0 },
    // TTL helper — Mongo TTL index purges old windows (see schema.index below).
    expiresAt: { type: Date, required: true },
  },
  { collection: "rate_buckets" }
);

rateBucketSchema.index({ key: 1, windowStart: 1 }, { unique: true });
// Auto-delete ~2 minutes after window start (window is 60s; keep a little headroom).
rateBucketSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("RateBucket", rateBucketSchema);
