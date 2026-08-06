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
const { perConnCache } = require("../db/context");

// Cap document list cache only (not spend). Spend is always read fresh. Per-connection so each
// tenant caches its own caps.
const CAPS_TTL_MS = 5_000;
const _capsCache = perConnCache();

function invalidate() {
  _capsCache.invalidate();
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
function _matches(cap, ctx = {}) {
  if (!cap.dimension) return true; // global — includes internal spend
  if (ctx.internalKind) return false;  // scoped caps never see Arbr's own overhead
  switch (cap.dimension) {
    case "application": return cap.value === ctx.application;
    case "provider":    return cap.value === ctx.provider;
    case "user":        return cap.value === ctx.userId;
    case "department":  return cap.value === ctx.department;
    case "workflow":    return cap.value === ctx.workflow;
    case "model":       return cap.value === ctx.model;
    default: return false;
  }
}

// ALL enabled caps, any action. "alert" caps do not enforce (no block/downgrade) but
// still accumulate spend and fire warning/breach webhooks — that is how a per-user
// usage alert works. Previously only block/downgrade caps were loaded, so an alert
// cap never notified.
async function _activeCaps() {
  const c = _capsCache.get();
  if (c && Date.now() - c.at < CAPS_TTL_MS) return c.caps;
  const caps = await Cap.find({ enabled: true }).lean();
  _capsCache.set({ caps, at: Date.now() });
  return caps;
}

async function getSpend(cap, now = new Date()) {
  const key = windowKey(cap.period, now);
  const doc = await CapSpend.findOne({ capId: cap._id, windowKey: key }).lean();
  return doc ? Number(doc.spent) || 0 : 0;
}

// Shared: atomically $inc the current window counter for every matching cap in `caps`.
async function _bump(caps, ctx, amount) {
  const now = new Date();
  const ops = [];
  for (const cap of caps) {
    if (!_matches(cap, ctx)) continue;
    const key = windowKey(cap.period, now);
    ops.push(
      CapSpend.findOneAndUpdate(
        { capId: cap._id, windowKey: key },
        { $inc: { spent: amount }, $set: { updatedAt: now } },
        { upsert: true, returnDocument: "after" }
      ).catch((err) => {
        console.error("[capEngine] counter $inc failed:", err.message);
      })
    );
  }
  if (ops.length) await Promise.all(ops);
}

// Atomic $inc after a priced request. No-ops for zero/negative cost. Applies only to
// spend-metric caps (request-metric caps are counted by recordRequest, not by cost). ctx
// carries the request's scope fields (application/provider/user/department/workflow/model)
// so a cap on any of those dimensions accumulates.
async function recordSpend(totalCost, ctx = {}) {
  const cost = Number(totalCost) || 0;
  if (cost <= 0) return;
  const caps = (await _activeCaps()).filter((c) => (c.metric || "spend") === "spend");
  await _bump(caps, ctx, cost);
}

// Atomic +1 per customer-facing request, for request-metric caps only. Called once per
// successful request regardless of cost (so $0 / cached requests still count). Arbr's own
// internal overhead calls (classification, policy generation, ...) are not the customer's
// requests, so they never burn a request quota — the caller passes internalKind and we skip.
async function recordRequest(ctx = {}) {
  if (ctx.internalKind) return;
  const caps = (await _activeCaps()).filter((c) => c.metric === "requests");
  if (!caps.length) return;
  await _bump(caps, ctx, 1);
}

// The strictest enforcement for this request's scope: block > downgrade > null.
// Returns { action, cap, spent } or null. Alert-action caps fire webhooks but never
// enforce (they contribute no block/downgrade), so a per-user alert notifies without
// changing routing. ctx carries the full request scope.
async function enforcement(ctx = {}) {
  const caps = await _activeCaps();
  let hit = null;
  for (const cap of caps) {
    if (!_matches(cap, ctx)) continue;
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
  const caps = await Cap.find({ enabled: true }).lean();
  const now = new Date();
  let updated = 0;
  for (const cap of caps) {
    // Request-metric counters measure a raw count, not spend — analytics.spend can't realign
    // them. Their $inc counters are authoritative under normal operation; skip here.
    if ((cap.metric || "spend") !== "spend") continue;
    const spent = await analytics.spend({
      // The friendly "user" dimension maps to the analytics/record field "userId".
      dimension: cap.dimension === "user" ? "userId" : cap.dimension,
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
  recordRequest,
  getSpend,
  invalidate,
  describeScope,
  windowStart,
  windowKey,
  reconcileFromAnalytics,
  _shouldWarn: shouldWarn,
  _matches,
};
