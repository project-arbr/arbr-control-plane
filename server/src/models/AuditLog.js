// Immutable audit trail for admin operations. Written on every mutation to
// rules, caps, keys, connections, and settings. Read-only from the dashboard.
const mongoose = require("mongoose");

const auditLogSchema = new mongoose.Schema(
  {
    timestamp:  { type: Date,   default: Date.now, index: true },
    action:     { type: String, required: true },   // e.g. "rule.create", "cap.delete"
    entity:     { type: String, required: true },   // e.g. "rule", "cap", "key", "settings"
    entityId:   { type: String, default: null },    // Mongo _id of the affected document
    changes:    { type: mongoose.Schema.Types.Mixed, default: null }, // before/after or payload
    actor:      { type: String, default: "admin" }, // future: per-user when multi-admin lands
  },
  { collection: "auditlogs" }
);

module.exports = mongoose.model("AuditLog", auditLogSchema);
