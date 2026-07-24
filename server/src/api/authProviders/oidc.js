// Generic OIDC authorization-code + PKCE flow. Works against any compliant
// issuer (Okta, Auth0, Google Workspace, Keycloak, ...) — no provider-specific
// code. The pending-auth cookie carries state/PKCE verifier across the
// redirect; it's signed with a per-boot secret since it only needs to survive
// one round trip (a restart mid-login just means the user retries).
const crypto = require("crypto");
const express = require("express");
// v6 dropped the v5 Issuer/Client class API for a functional one — discovery()
// replaces Issuer.discover()+new issuer.Client(), buildAuthorizationUrl()/
// authorizationCodeGrant() replace client.authorizationUrl()/client.callback().
const { discovery, randomPKCECodeVerifier, calculatePKCECodeChallenge, randomState, buildAuthorizationUrl, authorizationCodeGrant } = require("openid-client");
const { SignJWT, jwtVerify } = require("jose");
const { config } = require("../../config");
const User = require("../../models/User");
const Session = require("../../models/Session");
const { SESSION_COOKIE } = require("../identity");

const PENDING_COOKIE = "arbr_oidc_pending";
const pendingSecret = crypto.randomBytes(32);

const router = express.Router();

// For OAuth clients shared with other apps (e.g. one already registered for a
// public-signup product) that accept any account — restrict who can actually
// reach arbr regardless. Empty allowlist = no restriction.
function isAllowedEmailDomain(email, allowedDomains) {
  if (!allowedDomains.length) return true;
  const domain = String(email).toLowerCase().split("@")[1] || "";
  return allowedDomains.includes(domain);
}

// Discovery result (a Configuration) replaces v5's Client instance — every call
// site below takes it as the first argument instead of calling methods on it.
let configPromise = null;
function getOidcConfig() {
  if (!configPromise) {
    configPromise = discovery(new URL(config.oidc.issuer), config.oidc.clientId, config.oidc.clientSecret);
  }
  return configPromise;
}

function requireOidcMode(req, res, next) {
  if (config.authMode !== "oidc") return res.status(404).json({ error: "not_found" });
  return next();
}

router.get("/login", requireOidcMode, async (req, res, next) => {
  try {
    const oidcConfig = await getOidcConfig();
    const code_verifier = randomPKCECodeVerifier();
    const code_challenge = await calculatePKCECodeChallenge(code_verifier);
    const state = randomState();
    const pending = await new SignJWT({ state, code_verifier })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("10m")
      .sign(pendingSecret);
    res.cookie(PENDING_COOKIE, pending, {
      httpOnly: true,
      secure: config.isProduction,
      sameSite: "lax",
      maxAge: 10 * 60 * 1000,
    });
    const authUrl = buildAuthorizationUrl(oidcConfig, {
      redirect_uri: config.oidc.redirectUri,
      scope: "openid email profile",
      state,
      code_challenge,
      code_challenge_method: "S256",
    });
    res.redirect(authUrl.href);
  } catch (err) {
    next(err);
  }
});

router.get("/callback", requireOidcMode, async (req, res, next) => {
  try {
    const raw = req.cookies && req.cookies[PENDING_COOKIE];
    if (!raw) return res.status(400).send("Login session expired — please try signing in again.");
    res.clearCookie(PENDING_COOKIE);
    const { payload } = await jwtVerify(raw, pendingSecret);

    // Checked explicitly (not just via authorizationCodeGrant's own expectedState
    // check below) so a mismatch gets this specific message rather than whatever
    // generic error the library throws for it.
    if (req.query.state !== payload.state) {
      return res.status(400).send("Login state mismatch — please try signing in again.");
    }

    const oidcConfig = await getOidcConfig();
    const currentUrl = new URL(req.originalUrl, `${req.protocol}://${req.get("host")}`);
    const tokens = await authorizationCodeGrant(oidcConfig, currentUrl, {
      pkceCodeVerifier: payload.code_verifier,
      expectedState: payload.state,
    }, {
      redirect_uri: config.oidc.redirectUri,
    });
    const claims = tokens.claims();
    if (!claims || !claims.email) {
      return res.status(400).send("Your identity provider did not return an email claim.");
    }
    const email = String(claims.email).toLowerCase();
    if (!isAllowedEmailDomain(email, config.oidc.allowedDomains)) {
      return res.status(403).send(
        `Sign-in is restricted to ${config.oidc.allowedDomains.join(", ")}. Contact an administrator if this is unexpected.`
      );
    }

    let user = await User.findOne({ email });
    if (!user) {
      user = new User({ email, role: "viewer" });
    } else if (user.disabledAt) {
      return res.status(403).send("This account has been disabled. Contact an administrator.");
    }
    user.oidcSubject = claims.sub;
    user.lastLoginAt = new Date();
    await user.save();

    const sessionId = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + config.sessionTtlHours * 3600 * 1000);
    await Session.create({ _id: sessionId, userId: user._id, expiresAt });
    res.cookie(SESSION_COOKIE, sessionId, {
      httpOnly: true,
      secure: config.isProduction,
      sameSite: "lax",
      expires: expiresAt,
    });
    res.redirect("/");
  } catch (err) {
    next(err);
  }
});

router.post("/logout", async (req, res) => {
  const sessionId = req.cookies && req.cookies[SESSION_COOKIE];
  if (sessionId) await Session.deleteOne({ _id: sessionId });
  res.clearCookie(SESSION_COOKIE);
  res.json({ ok: true });
});

module.exports = router;
module.exports.isAllowedEmailDomain = isAllowedEmailDomain;
