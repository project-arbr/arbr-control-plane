// Per-request identity resolution for the non-adminkey auth modes. Called from
// adminAuth.middleware (enforcing) and GET /api/auth/me (non-enforcing, may
// return null). The admin-key break-glass path is handled entirely in
// adminAuth.js and never reaches here.
const { config } = require("../config");
const User = require("../models/User");
const Session = require("../models/Session");
const trustedHeader = require("./authProviders/trustedHeader");

const SESSION_COOKIE = "arbr_session";

function toIdentity(user) {
  return { id: String(user._id), email: user.email, role: user.role };
}

async function resolveOidcSession(req) {
  const sessionId = req.cookies && req.cookies[SESSION_COOKIE];
  if (!sessionId) return null;
  const session = await Session.findById(sessionId);
  if (!session) return null;
  const user = await User.findById(session.userId);
  if (!user || user.disabledAt) return null;
  session.lastSeenAt = new Date();
  session.save().catch(() => {}); // best-effort, never blocks the request
  return toIdentity(user);
}

async function resolveTrustedHeader(req) {
  const claimed = await trustedHeader.verify(req);
  if (!claimed || !claimed.email) return null;
  const email = claimed.email.toLowerCase();
  let user = await User.findOne({ email });
  if (!user) {
    // Auto-provisioned from a trusted identity source; still starts at the
    // least-privileged role until an administrator promotes them.
    user = await User.create({ email, oidcSubject: claimed.sub || null, role: "viewer" });
  } else if (user.disabledAt) {
    return null;
  }
  return toIdentity(user);
}

async function resolveUser(req) {
  if (config.authMode === "oidc") return resolveOidcSession(req);
  if (config.authMode === "trusted-header") return resolveTrustedHeader(req);
  return null; // adminkey mode has no per-user identity beyond the master key
}

module.exports = { resolveUser, SESSION_COOKIE };
