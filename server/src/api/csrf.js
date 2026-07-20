// CSRF protection (double-submit cookie pattern) for cookie-authenticated
// (oidc) sessions. Bearer-token auth (the admin key) and trusted-header auth
// aren't CSRF-exposed — a forged cross-site request can't make the browser
// attach a custom Authorization/proxy-secret header the way cookies are
// attached automatically — so protection only activates when a session
// cookie is actually present (skipCsrfProtection below).
const crypto = require("crypto");
const { doubleCsrf } = require("csrf-csrf");
const { config } = require("../config");
const { SESSION_COOKIE } = require("./identity");

// Falls back to a per-boot random secret when ARBR_ENCRYPTION_KEY is unset —
// harmless since this only matters once ARBR_AUTH_MODE=oidc is configured
// (adminkey mode, the default, never sets a session cookie to begin with).
const secret = process.env.ARBR_ENCRYPTION_KEY || crypto.randomBytes(32).toString("hex");

const { generateCsrfToken, doubleCsrfProtection } = doubleCsrf({
  getSecret: () => secret,
  getSessionIdentifier: (req) => (req.cookies && req.cookies[SESSION_COOKIE]) || "no-session",
  cookieName: "arbr_csrf",
  cookieOptions: { httpOnly: true, sameSite: "lax", secure: config.isProduction, path: "/" },
  skipCsrfProtection: (req) => !(req.cookies && req.cookies[SESSION_COOKIE]),
});

module.exports = { protection: doubleCsrfProtection, generateCsrfToken };
