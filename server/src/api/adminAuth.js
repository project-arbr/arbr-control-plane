// Admin auth for the dashboard / admin API (everything under /api, except
// /api/auth/* which is mounted ahead of this middleware — see index.js).
//
// Two layers, always in this order:
//   1. Master key (ARBR_ADMIN_KEY) — sessionless break-glass credential, works
//      in every authMode. Not the everyday human login path once a real
//      identity mode is configured; kept for bootstrap + server-side
//      automation (ops/deploy.sh health checks, CI). Resolves to a standing
//      "master-key" identity so audit entries never default to "admin".
//   2. Per-user identity (config.authMode: "oidc" or "trusted-header") via
//      identity.resolveUser() — a real session or a verified trusted header.
//
//   - authMode "adminkey" (default) + ARBR_ADMIN_KEY unset → middleware
//     passes everything through (local dev/demo; config.describe() warns).
//   - Otherwise every /api/* request must resolve to a master-key OR
//     per-user identity, EXCEPT: GET /api/status also accepts a valid
//     GATEWAY API key, so SDK status() healthchecks work without either.
//
// The data plane (/v1/*) is NOT handled here — it uses gateway API keys
// (gateway/auth.js). /health sits outside /api and stays public.
const { config } = require("../config");
const { timingSafeEqual, bearerOf } = require("./authUtil");
const identity = require("./identity");
const secretResolver = require("../security/secretResolver");

const MASTER_USER = { id: "master-key", email: "master-key", role: "administrator", isMasterKey: true };

// Live read so a rotated ARBR_ADMIN_KEY (via a secret-manager reference)
// takes effect on the next periodic refresh / manual refresh call, with no
// restart. Returns undefined (never a still-unresolved ref string) when
// resolution hasn't happened or failed — config.adminKey (the raw env
// value) is used only to detect "was anything configured at all", below,
// never as a fallback credential here.
function effectiveAdminKey() {
  return secretResolver.resolvedOrLiteral("ARBR_ADMIN_KEY");
}

function isAdminRequest(req) {
  const token = bearerOf(req);
  const adminKey = effectiveAdminKey();
  return !!(token && adminKey && timingSafeEqual(token, adminKey));
}

async function middleware(req, res, next) {
  try {
    if (!config.adminKey && config.authMode === "adminkey") {
      req.user = MASTER_USER; // dev/demo: open, warned at boot — still gives rbac/audit a real actor
      return next();
    }

    if (isAdminRequest(req)) {
      req.user = MASTER_USER;
      return next();
    }

    const user = await identity.resolveUser(req);
    if (user) {
      req.user = user;
      return next();
    }

    // SDK healthcheck exception: /api/status with a valid GATEWAY key.
    if (req.method === "GET" && (req.path === "/status" || req.path === "/status/")) {
      const token = bearerOf(req);
      if (token && token.startsWith("ab_")) {
        // Lazy require to avoid a config-time cycle.
        const ApiKey = require("../models/ApiKey");
        const gatewayAuth = require("../gateway/auth");
        const doc = await ApiKey.findOne({
          keyHash: gatewayAuth.hashKey(token),
          enabled: true,
          revokedAt: null,
        }).lean();
        if (doc) return next();
      }
    }

    return res.status(401).json({
      error: "admin_auth_required",
      message:
        config.authMode === "adminkey"
          ? "This instance requires the admin key (Authorization: Bearer <ARBR_ADMIN_KEY>)."
          : "Sign in required (or Authorization: Bearer <ARBR_ADMIN_KEY> for break-glass access).",
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = { middleware, isAdminRequest, MASTER_USER };
