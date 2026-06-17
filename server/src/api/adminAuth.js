// Master-key auth for the dashboard / admin API (everything under /api).
//
// Model (LiteLLM master-key style): one ARBR_ADMIN_KEY env value IS the
// credential — sessionless, sent as `Authorization: Bearer <key>` by the
// dashboard (stored client-side after login) or any admin tooling.
//
//   - ARBR_ADMIN_KEY unset → middleware passes everything through (local
//     dev / demo; config.describe() prints a loud warning at boot).
//   - Set → every /api/* request must carry the admin key, EXCEPT:
//       GET /api/status — also accepted with a valid GATEWAY API key, so SDK
//       status() healthchecks keep working without the admin credential.
//
// The data plane (/v1/*) is NOT handled here — it uses gateway API keys
// (gateway/auth.js). /health sits outside /api and stays public.
//
// Structured so richer schemes (user accounts, SSO) can slot in behind the
// same gate later: everything funnels through isAdminRequest().
const crypto = require("crypto");
const { config } = require("../config");

function timingSafeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function bearerOf(req) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : null;
}

function isAdminRequest(req) {
  const token = bearerOf(req);
  return !!(token && config.adminKey && timingSafeEqual(token, config.adminKey));
}

async function middleware(req, res, next) {
  try {
    if (!config.adminKey) return next(); // dev/demo: open, warned at boot
    if (isAdminRequest(req)) return next();

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
      message: "This instance requires the admin key (Authorization: Bearer <ARBR_ADMIN_KEY>).",
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = { middleware, isAdminRequest };
