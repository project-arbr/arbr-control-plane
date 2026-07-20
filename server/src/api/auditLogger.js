// Thin helper for writing admin action audit entries. Fire-and-forget — logging
// failures are swallowed so they never surface into the admin API response path.
const AuditLog = require("../models/AuditLog");

// actor is req.user ({ id, email, role }), always set by adminAuth.middleware
// by the time a route handler runs. Stored as-is (schema field is Mixed) so
// every entry names a real identity — never the "admin" default again.
async function logAction(action, entity, entityId, changes, actor) {
  try {
    await AuditLog.create({
      action,
      entity,
      entityId: String(entityId || ""),
      changes,
      actor: actor ? { id: actor.id, email: actor.email, role: actor.role } : undefined,
    });
  } catch (err) {
    console.error("[audit] failed to write log entry:", err.message);
  }
}

module.exports = { logAction };
