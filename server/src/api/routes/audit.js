// Admin API routes — audit
const express = require("express");
const AuditLog = require("../../models/AuditLog");

const router = express.Router();

// ── Audit log (admin actions) ──
router.get("/audit", async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const page  = Math.max(Number(req.query.page)  || 1,  1);
    const [items, total] = await Promise.all([
      AuditLog.find().sort({ timestamp: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      AuditLog.countDocuments(),
    ]);
    res.json({ items, total, page, limit });
  } catch (e) { next(e); }
});

// Audit CSV export — no pagination, same optional filters as /audit.
router.get("/audit/export", async (req, res, next) => {
  try {
    const { action, entity, from, to } = req.query;
    const match = {};
    if (action) match.action = action;
    if (entity) match.entity = entity;
    if (from || to) {
      match.timestamp = {};
      if (from) match.timestamp.$gte = new Date(from);
      if (to)   match.timestamp.$lte = new Date(to);
    }
    const rows = await AuditLog.find(match).sort({ timestamp: -1 }).limit(10000).lean();
    const header = "timestamp,action,entity,entityId,actor,changes\n";
    const csv = rows.map((r) => [
      new Date(r.timestamp).toISOString(),
      r.action || "",
      r.entity || "",
      r.entityId || "",
      r.actor || "admin",
      JSON.stringify(r.changes || {}).replace(/"/g, '""'),
    ].map((v) => `"${v}"`).join(",")).join("\n");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="audit-log.csv"');
    res.send(header + csv);
  } catch (e) { next(e); }
});


module.exports = router;
