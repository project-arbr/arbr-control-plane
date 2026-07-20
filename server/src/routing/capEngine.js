// Budget enforcement with hard, multi-replica-safe spend counters.
//
// Hot path:
//   1. enforcement() — read CapSpend counters (atomic source of truth for block/downgrade)
//   2. recordSpend() — after a successful priced call, $inc matching caps
//
// Soft overshoot of at most one in-flight request is still possible (cost is
// known only after the provider responds). That is intentional and far tighter
// than the previous ~30s aggregation cache, which could overshoot under burst
// and diverge across processes.
//
// Dashboards still use analytics.spend (full aggregation). reconcileFromAnalytics()
// realigns counters if they drift.
const Cap = require("../models/Cap");
const CapSpend = require("../models/CapSpend");
const analytics = require("../analytics/aggregate");
const notifier = require("./notifier");

// Cap document list cache only (not spend). Spend is always read fresh.
const CAPS_TTL_MS = 5_000;
let _capsCache = { caps: [], at: 0 };

function invalidate() {
  _capsCache.at = 0;
}

// Pure: rolling window start for a cap period.
function windowStart(period, now = Date.now()) {
  const ms = period === "day" ? 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000;
  return new Date(now - ms);
}

// Pure: stable window key for atomic counters (calendar day / calendar month UTC).
// Counters roll at UTC midnight / month boundary — close enough for enforcement;
// dashboards use true rolling windows via analytics.
function windowKey(period, now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  if (period === "day") return `day:${y}-${m}-${day}`;
  return `month:${y}-${m}`;
}

// Which caps a given spend event counts against.
//
// Arbr's own internal calls (classification, policy generation, eval judging) are real
// money on the customer's provider key, so they DO count against a global cap. They do
// NOT count against a scoped cap: a per-application or per-provider cap is a control
// over that scope's traffic, and overhead belongs to no customer scope. Internal
// records carry no application, so the application branch already excludes them; the
// provider branch needs an explicit guard because they do carry a real provider.
function _matches(cap, { application, provider, internalKind = null }) {
  if (!cap.dimension) return true; // global — includes internal spend
  if (internalKind) return false;  // scoped caps never see Arbr's own overhead
  if (cap.dimension === "application") return cap.value === application;
  if (cap.dimension === "provider") return cap.value === provider;
  return false; // other dimensions not enforced at the gateway (yet)
}

async function _enforcingCaps() {
  if (Date.now() - _capsCache.at < CAPS_TTL_MS) return _capsCache.caps;
  const caps = await Cap.find({ enabled: true, action: { $in: ["block", "downgrade"] } }).lean();
  _capsCache = { caps, at: Date.now() };
  return caps;
}

async function getSpend(cap, now = new Date()) {
  const key = windowKey(cap.period, now);
  const doc = await CapSpend.findOne({ capId: cap._id, windowKey: key }).lean();
  return doc ? Number(doc.spent) || 0 : 0;
}

// Atomic $inc after a priced request. No-ops for zero/negative cost.
async function recordSpend(totalCost, { application, provider, internalKind = null } = {}) {
  const cost = Number(totalCost) || 0;
  if (cost <= 0) return;
  const caps = await _enforcingCaps();
  const now = new Date();
  const ops = [];
  for (const cap of caps) {
    if (!_matches(cap, { application, provider, internalKind })) continue;
    const key = windowKey(cap.period, now);
    ops.push(
      CapSpend.findOneAndUpdate(
        { capId: cap._id, windowKey: key },
        { $inc: { spent: cost }, $set: { updatedAt: now } },
        { upsert: true, returnDocument: "after" }
      ).catch((err) => {
        console.error("[capEngine] recordSpend failed:", err.message);
      })
    );
  }
  if (ops.length) await Promise.all(ops);
}

// The strictest enforcement for this request's scope: block > downgrade > null.
// Returns { action, cap, spent } or null.
async function enforcement({ application, provider }) {
  const caps = await _enforcingCaps();
  let hit = null;
  for (const cap of caps) {
    if (!_matches(cap, { application, provider })) continue;
    const spent = await getSpend(cap);
    if (spent >= cap.limit) {
      setImmediate(() =>
        notifier.notify("cap_breach", {
          key: `${cap._id}`,
          dimension: cap.dimension || "global",
          value: cap.value || null,
          period: cap.period,
          limit: cap.limit,
          spent,
          action: cap.action,
        })
      );
      if (cap.action === "block") return { action: "block", cap, spent };
      if (!hit) hit = { action: "downgrade", cap, spent };
    } else {
      const warnAt = cap.warningThreshold ?? 0.8;
      if (shouldWarn(spent, cap.limit, warnAt)) {
        setImmediate(() =>
          notifier.notify("cap_warning", {
            key: `warn:${cap._id}`,
            dimension: cap.dimension || "global",
            value: cap.value || null,
            period: cap.period,
            limit: cap.limit,
            spent,
            ratio: Math.round((spent / cap.limit) * 1000) / 1000,
            action: cap.action,
          })
        );
      }
    }
  }
  return hit;
}

function describeScope(cap) {
  return cap.dimension ? `${cap.dimension} "${cap.value}"` : "global spend";
}

// Pure predicate — exported for unit testing.
function shouldWarn(spent, limit, warnAt) {
  return warnAt > 0 && spent < limit && spent / limit >= warnAt;
}

// Realign CapSpend from analytics aggregation (rolling window). Call from admin
// or a periodic job; not on the hot path.
async function reconcileFromAnalytics() {
  const caps = await Cap.find({ enabled: true, action: { $in: ["block", "downgrade"] } }).lean();
  const now = new Date();
  let updated = 0;
  for (const cap of caps) {
    const spent = await analytics.spend({
      dimension: cap.dimension,
      value: cap.value,
      from: windowStart(cap.period, now.getTime()),
      // Must mirror _matches, or reconciliation would overwrite the counters with a
      // differently-scoped total and reintroduce the drift it exists to fix.
      includeInternal: !cap.dimension,
    });
    const key = windowKey(cap.period, now);
    await CapSpend.findOneAndUpdate(
      { capId: cap._id, windowKey: key },
      { $set: { spent, updatedAt: now } },
      { upsert: true }
    );
    updated += 1;
  }
  invalidate();
  return { updated };
}

module.exports = {
  enforcement,
  recordSpend,
  getSpend,
  invalidate,
  describeScope,
  windowStart,
  windowKey,
  reconcileFromAnalytics,
  _shouldWarn: shouldWarn,
  _matches,
};
