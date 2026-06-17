// A cost cap (budget). Dimension-agnostic: a cap targets a scope — an application,
// a provider, a department, a model, or the whole org (dimension = null) — over a
// rolling window. `action` is "alert" for now (observe, don't enforce); the same
// shape extends to "downgrade"/"block" later without a data migration.
const mongoose = require("mongoose");

const capSchema = new mongoose.Schema(
  {
    // null dimension = global (all spend). Otherwise a RequestRecord field.
    dimension: { type: String, default: null }, // "application" | "provider" | "department" | "model" | null
    value: { type: String, default: null },      // the scope value (e.g. "support-chat"); null for global
    period: { type: String, enum: ["day", "month"], default: "month" }, // rolling 24h / 30d
    limit: { type: Number, required: true },      // USD
    // alert = flag only; downgrade = force the provider's light model while breached;
    // block = reject requests in scope (429) until the window rolls past.
    action: { type: String, enum: ["alert", "downgrade", "block"], default: "alert" },
    enabled: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now },
  },
  { collection: "caps" }
);

module.exports = mongoose.model("Cap", capSchema);
