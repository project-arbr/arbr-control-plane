// A usage cap. Dimension-agnostic: a cap targets a scope — an application,
// a provider, a department, a model, an end user, or the whole org (dimension = null)
// — over a period. `metric` chooses what is counted: "spend" (USD budget, the default) or
// "requests" (a raw request-count quota). `action`: alert (notify only), downgrade, or block.
// All actions use the hard CapSpend counters (see routing/capEngine.js) and fire warning/breach
// webhooks; dashboards use analytics.spend.
const mongoose = require("mongoose");
const { defineModel } = require("../db/context");

const capSchema = new mongoose.Schema(
  {
    // null dimension = global (all spend). Otherwise a RequestRecord field.
    // "user" is the friendly alias for the record's `userId` (per-end-user budgets).
    dimension: { type: String, default: null }, // "application" | "provider" | "department" | "model" | "user" | null
    value: { type: String, default: null },      // the scope value (e.g. "support-chat"); null for global
    period: { type: String, enum: ["day", "month"], default: "month" }, // rolling 24h / 30d
    // What the counter measures. "spend" preserves the original USD-budget behaviour (default,
    // so existing caps and OSS are unchanged); "requests" counts customer-facing requests, so
    // `limit` becomes a request quota (e.g. a free-tier "N requests / month").
    metric: { type: String, enum: ["spend", "requests"], default: "spend" },
    limit: { type: Number, required: true },      // USD when metric="spend"; request count when metric="requests"
    // alert = notify (webhook) only, no routing change; downgrade = force the provider's
    // light model while breached; block = reject requests in scope (429) until the
    // window rolls past. Every action fires cap_warning / cap_breach webhooks.
    action: { type: String, enum: ["alert", "downgrade", "block"], default: "alert" },
    // Fraction of limit at which a cap_warning webhook fires (0 = disabled, default 0.8 = 80%).
    warningThreshold: { type: Number, default: 0.8 },
    enabled: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now },
  },
  { collection: "caps" }
);

module.exports = defineModel("Cap", capSchema);
