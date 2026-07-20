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
    // { id, email, role } for per-user/master-key actions (F-04). Mixed (not a
    // strict subdocument) so pre-F-04 rows, which stored a plain string like
    // "admin", still load without a cast error — render with
    // `typeof actor === "string" ? actor : actor.email`.
    actor:      { type: mongoose.Schema.Types.Mixed, default: "unknown" },
  },
  { collection: "auditlogs" }
);

module.exports = mongoose.model("AuditLog", auditLogSchema);
