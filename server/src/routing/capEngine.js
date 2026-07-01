// Budget enforcement: turns breached caps with action "block"/"downgrade" into a
// per-request decision. Breach status is recomputed at most every 30s (each check
// is a Mongo aggregation over the rolling window), so the request hot path is an
// in-memory scan. Alert-only caps are ignored here — they surface in the UI only.
const Cap = require("../models/Cap");
const analytics = require("../analytics/aggregate");
const notifier = require("./notifier");

const TTL_MS = 30_000;
let _cache = { breached: [], at: 0 };

function invalidate() {
  _cache.at = 0;
}

function windowStart(period) {
  const ms = period === "day" ? 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000;
  return new Date(Date.now() - ms);
}

async function _breachedEnforcing() {
  if (Date.now() - _cache.at < TTL_MS) return _cache.breached;
  const caps = await Cap.find({ enabled: true, action: { $in: ["block", "downgrade"] } }).lean();
  const breached = [];
  for (const cap of caps) {
    const spent = await analytics.spend({
      dimension: cap.dimension,
      value: cap.value,
      from: windowStart(cap.period),
    });
    if (spent >= cap.limit) {
      breached.push({ ...cap, spent });
      // Fire-and-forget webhook on first detection of this breach (dedup inside notifier).
      setImmediate(() => notifier.notify("cap_breach", {
        key: `${cap._id}`,
        dimension: cap.dimension || "global",
        value: cap.value || null,
        period: cap.period,
        limit: cap.limit,
        spent,
        action: cap.action,
      }));
    } else {
      // Near-threshold warning: fire before the cap is actually breached so users can act.
      const warnAt = cap.warningThreshold ?? 0.8;
      if (warnAt > 0 && spent / cap.limit >= warnAt) {
        setImmediate(() => notifier.notify("cap_warning", {
          key: `warn:${cap._id}`,
          dimension: cap.dimension || "global",
          value: cap.value || null,
          period: cap.period,
          limit: cap.limit,
          spent,
          ratio: Math.round((spent / cap.limit) * 1000) / 1000,
          action: cap.action,
        }));
      }
    }
  }
  _cache = { breached, at: Date.now() };
  return breached;
}

function _matches(cap, { application, provider }) {
  if (!cap.dimension) return true; // global
  if (cap.dimension === "application") return cap.value === application;
  if (cap.dimension === "provider") return cap.value === provider;
  return false; // other dimensions not enforced at the gateway (yet)
}

// The strictest enforcement for this request's scope: block > downgrade > null.
// Returns { action, cap } or null.
async function enforcement({ application, provider }) {
  const breached = await _breachedEnforcing();
  let hit = null;
  for (const cap of breached) {
    if (!_matches(cap, { application, provider })) continue;
    if (cap.action === "block") return { action: "block", cap };
    if (!hit) hit = { action: "downgrade", cap };
  }
  return hit;
}

function describeScope(cap) {
  return cap.dimension ? `${cap.dimension} "${cap.value}"` : "global spend";
}

module.exports = { enforcement, invalidate, describeScope, windowStart };
