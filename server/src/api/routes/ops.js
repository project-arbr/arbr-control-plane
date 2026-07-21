// Admin API routes — operational readiness (F-08): config export/import and a
// support-diagnostics bundle. Every route here is deliberately scoped to never
// query ProviderCredential/CustomProvider (secrets) or raw RequestRecord
// documents (captured prompt/response text) — exclusion by construction, not a
// redaction pass that could miss a field. See docs/operational-readiness.md.
const express = require("express");
const { requireRole } = require("../rbac");
const { describe } = require("../../config");
const Settings = require("../../models/Settings");
const Rule = require("../../models/Rule");
const Cap = require("../../models/Cap");
const AuditLog = require("../../models/AuditLog");
const RequestRecord = require("../../models/RequestRecord");

const router = express.Router();
const EXPORT_VERSION = 1;

// Strip mongoose/internal fields so a re-import creates fresh documents
// rather than attempting to overwrite by a possibly-foreign _id.
function stripInternal({ _id, __v, ...rest }) {
  return rest;
}

// Copies only real Settings schema fields out of an imported object, derived
// from the schema itself (not a hand-maintained list, so it can't drift).
// Values are still whatever the caller sent — that's the point of import —
// but the KEY SET reaching Mongo's $set is fixed by code, never by the
// request body, so an imported object can't inject an operator-shaped key
// ($where, $rename, a dotted path, __proto__, ...) into the update.
// schema.paths has one entry PER LEAF, so a subdocument field like
// maintenanceMode appears as "maintenanceMode.enabled"/"maintenanceMode.message"
// rather than a single "maintenanceMode" key — take only the top-level
// segment (deduped) so nested groups are copied as whole objects, matching
// both what export produces and what $set expects.
const SETTINGS_FIELDS = [...new Set(
  Object.keys(Settings.schema.paths)
    .map((p) => p.split(".")[0])
    .filter((k) => !["_id", "__v", "key"].includes(k))
)];
function pickSettingsFields(obj) {
  const out = {};
  if (!obj || typeof obj !== "object") return out;
  for (const k of SETTINGS_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  }
  return out;
}

// ── config/policy export + import ──
router.get("/ops/export", requireRole("administrator"), async (_req, res, next) => {
  try {
    const [settings, rules, caps] = await Promise.all([
      Settings.get(),
      Rule.find().lean(),
      Cap.find().lean(),
    ]);
    res.json({
      exportVersion: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      settings: stripInternal(settings.toObject ? settings.toObject() : settings),
      rules: rules.map(stripInternal),
      caps: caps.map(stripInternal),
    });
  } catch (e) { next(e); }
});

router.post("/ops/import", requireRole("administrator"), async (req, res, _next) => {
  try {
    const body = req.body || {};
    if (body.exportVersion !== EXPORT_VERSION) {
      return res.status(400).json({
        error: "unsupported_export_version",
        message: `Expected exportVersion ${EXPORT_VERSION}, got ${body.exportVersion}.`,
      });
    }

    if (body.settings && typeof body.settings === "object") {
      await Settings.updateOne(
        { key: "global" },
        { $set: { ...pickSettingsFields(body.settings), key: "global" } },
        { upsert: true }
      );
      Settings.invalidateCache();
    }

    let rulesImported = 0, capsImported = 0;
    if (Array.isArray(body.rules)) {
      // New _ids — this is a config restore, not an ID-preserving merge.
      // isDemoFixture is forced false: a real config restore must never be
      // silently deletable by an unrelated instance's demo:reset cleanup.
      const docs = body.rules.map((r) => ({ ...stripInternal(r), isDemoFixture: false }));
      if (docs.length) await Rule.insertMany(docs);
      rulesImported = docs.length;
    }
    if (Array.isArray(body.caps)) {
      const docs = body.caps.map((c) => stripInternal(c));
      if (docs.length) await Cap.insertMany(docs);
      capsImported = docs.length;
    }

    res.json({ ok: true, rulesImported, capsImported });
  } catch (e) {
    res.status(400).json({ error: "import_failed", message: String(e.message || e) });
  }
});

// ── support bundle ──
router.post("/ops/support-bundle", requireRole("administrator"), async (_req, res, next) => {
  try {
    let pkg = {};
    try { pkg = require("../../../../package.json"); } catch { /* version unknown */ }

    const [settings, disk, requestStats, recentAudit] = await Promise.all([
      Settings.get(),
      diskUsage(),
      requestStats24h(),
      recentAuditEntries(),
    ]);

    res.json({
      generatedAt: new Date().toISOString(),
      about: { version: pkg.version, name: pkg.name, nodeVersion: process.version },
      config: describe(),
      settings: stripInternal(settings.toObject ? settings.toObject() : settings),
      disk,
      requestStats,
      recentAudit,
    });
  } catch (e) { next(e); }
});

async function diskUsage() {
  try {
    const stats = await require("fs").promises.statfs("/");
    const totalBytes = stats.blocks * stats.bsize;
    const freeBytes = stats.bfree * stats.bsize;
    return { totalBytes, freeBytes, usedPct: Math.round(((totalBytes - freeBytes) / totalBytes) * 1000) / 10 };
  } catch (e) {
    return { error: String(e.message || e) }; // statfs is POSIX-only; degrade, don't fail the bundle
  }
}

// Counts/rates only — never .find() on raw RequestRecord documents, so there's
// no captured messages/responseText field to accidentally include.
async function requestStats24h() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [row] = await RequestRecord.aggregate([
    { $match: { timestamp: { $gte: since } } },
    { $group: {
        _id: null,
        total: { $sum: 1 },
        failures: { $sum: { $cond: [{ $eq: ["$status", "failure"] }, 1, 0] } },
    } },
  ]);
  const total = row?.total || 0;
  const failures = row?.failures || 0;
  return { total, failures, errorRatePct: total ? Math.round((failures / total) * 1000) / 10 : 0 };
}

// Projected fields only — `changes` (unenforced Mixed) is dropped entirely,
// not trusted to never hold something sensitive.
async function recentAuditEntries() {
  return AuditLog.find()
    .sort({ timestamp: -1 })
    .limit(50)
    .select("timestamp action entity entityId actor")
    .lean();
}

module.exports = router;
