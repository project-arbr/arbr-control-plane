// Thin helper for writing admin action audit entries. Fire-and-forget — logging
// failures are swallowed so they never surface into the admin API response path.
const AuditLog = require("../models/AuditLog");

async function logAction(action, entity, entityId, changes) {
  try {
    await AuditLog.create({ action, entity, entityId: String(entityId || ""), changes });
  } catch (err) {
    console.error("[audit] failed to write log entry:", err.message);
  }
}

module.exports = { logAction };
