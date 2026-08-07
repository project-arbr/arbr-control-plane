// Entitlement seam — the P0 hook that lets the hosted layer gate advanced features and size
// per-account limits by plan. In the open-source product this is a no-op: everything is on and
// nothing is limited, so `feature()` always allows.
//
// The hosted layer (arbr-cloud) attaches `req.entitlements = { plan, features, limits, seats }`
// in its request middleware; the core only ever READS it through these helpers, so the two sides
// stay decoupled and OSS carries no plan logic.
"use strict";

// OSS / single-tenant default: unrestricted. `features: null` means "no restriction".
const ALL_ON = Object.freeze({ plan: "oss", features: null, limits: {}, seats: Infinity });

function entitlementsFor(req) {
  return (req && req.entitlements) || ALL_ON;
}

// The gate the core checks at advanced-feature entry points. Returns true (allow) unless an
// entitlements object explicitly restricts the feature to a set that excludes `key`.
//   features == null  -> unrestricted (OSS default) -> allow everything
//   features is a Set -> allow only members
function feature(req, key) {
  const e = entitlementsFor(req);
  if (!e.features) return true;
  return e.features.has(key);
}

// A per-account limit (monthlySpendUsd / rpm / retentionDays / ...), or `fallback` when unset.
function limit(req, key, fallback = null) {
  const e = entitlementsFor(req);
  return e.limits && e.limits[key] != null ? e.limits[key] : fallback;
}

// Express middleware form of `feature()` for gating a whole route. Responds 402 (Payment
// Required) when the signed-in plan doesn't include `key`. In OSS (ALL_ON) it always allows,
// so self-hosted route behaviour is unchanged. For endpoints that mix gated and un-gated fields
// (e.g. PATCH /governance), call `feature(req, key)` inline instead of using this.
function requireFeature(key) {
  return function requireFeatureMw(req, res, next) {
    if (feature(req, key)) return next();
    return res.status(402).json({
      error: "upgrade_required",
      feature: key,
      message: `This feature (${key}) requires a paid plan.`,
    });
  };
}

module.exports = { entitlementsFor, feature, limit, requireFeature, ALL_ON };
