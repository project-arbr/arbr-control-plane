// Trusted-identity-header auth: the deployment sits behind something that has
// already authenticated the caller (GCP IAP, or any OIDC-aware reverse proxy).
// Two verification strategies, one output shape ({ email, sub } | null) so
// identity.js doesn't care which one is active.
const { config } = require("../../config");
const { timingSafeEqual } = require("../authUtil");
const { createRemoteJWKSet, jwtVerify } = require("jose");

const IAP_JWKS_URL = "https://www.gstatic.com/iap/verify/public_key-jwk";
const IAP_ISSUER = "https://cloud.google.com/iap";

let jwksPromise = null;
function iapJwks() {
  if (!jwksPromise) jwksPromise = createRemoteJWKSet(new URL(IAP_JWKS_URL));
  return jwksPromise;
}

// GCP IAP signs a JWT and puts it on every request it forwards — verify the
// signature and audience ourselves rather than trusting the header blindly.
async function verifyIap(req) {
  const token = req.headers["x-goog-iap-jwt-assertion"];
  if (!token || !config.trustedHeader.iapAudience) return null;
  try {
    const { payload } = await jwtVerify(token, iapJwks(), {
      issuer: IAP_ISSUER,
      audience: config.trustedHeader.iapAudience,
    });
    if (!payload.email) return null;
    return { email: String(payload.email), sub: payload.sub ? String(payload.sub) : null };
  } catch {
    return null; // expired/invalid signature — unauthenticated, not a server error
  }
}

// Generic reverse-proxy pattern: the proxy asserts identity via a header, and
// proves it's really the trusted proxy (not a caller who reached arbr
// directly) with a shared secret on a second header.
function verifyProxy(req) {
  const secret = config.trustedHeader.proxySecret;
  if (!secret) return null;
  const sent = req.headers[config.trustedHeader.proxySecretHeader.toLowerCase()];
  if (!sent || !timingSafeEqual(sent, secret)) return null;
  const email = req.headers[config.trustedHeader.proxyHeader.toLowerCase()];
  if (!email) return null;
  return { email: String(email), sub: null };
}

function verify(req) {
  return config.trustedHeader.strategy === "iap" ? verifyIap(req) : verifyProxy(req);
}

module.exports = { verify };
