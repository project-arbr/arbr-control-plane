"use strict";
// End-to-end check of the OIDC login/callback flow against openid-client v6's
// functional API (discovery/buildAuthorizationUrl/authorizationCodeGrant),
// migrated from the v5 Issuer/Client class API that v6 removed (the removal is
// exactly what broke /api/auth/login in production: `Cannot read properties of
// undefined (reading 'discover')`). Runs against a small fake OIDC provider (an
// https server, self-signed cert, implementing discovery + token endpoints)
// rather than a real IdP, so this is deterministic and offline, but it
// exercises the REAL openid-client functions end-to-end, not a mock of them.
//
// HTTPS (not plain http) is deliberate: oauth4webapi (which openid-client v6
// wraps) refuses http:// issuers by default — correctly, since every real IdP
// (Okta/Auth0/Google Workspace/Keycloak) is HTTPS. Loosening that in
// oidc.js just to make this fake IDP easier to stand up would weaken
// production auth code for the sake of a test, so the self-signed cert (and
// NODE_TLS_REJECT_UNAUTHORIZED=0, scoped to this test file's own process —
// `node --test` isolates each file in its own worker) lives entirely here.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const https = require("node:https");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { MongoMemoryServer } = require("mongodb-memory-server");
const mongoose = require("mongoose");
const express = require("express");
const cookieParser = require("cookie-parser");
const supertest = require("supertest");
const { SignJWT } = require("jose");

const CLIENT_ID = "test-client";
const CLIENT_SECRET = "test-secret-at-least-32-bytes-long!!";
const REDIRECT_URI = "http://localhost/api/auth/callback";
const USER_EMAIL = "alice@gyde.ai";
const USER_SUB = "fake-idp-subject-123";

let fakeIdp, fakeIdpUrl, mongod, agent, origTlsReject;

function generateSelfSignedCert() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arbr-oidc-test-cert-"));
  const keyPath = path.join(dir, "key.pem");
  const certPath = path.join(dir, "cert.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-keyout", keyPath, "-out", certPath,
    "-days", "1", "-nodes", "-subj", "/CN=127.0.0.1",
  ]);
  return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
}

// Minimal OIDC provider: discovery doc + a token endpoint that always returns a
// valid, freshly-signed ID token — enough for openid-client's real discovery()
// and authorizationCodeGrant() to run against, without a real browser consent
// step (the fake token endpoint doesn't need to validate the authorization
// code's authenticity for this test; it's standing in for the whole IdP).
function startFakeIdp() {
  const { key, cert } = generateSelfSignedCert();
  return new Promise((resolve) => {
    const server = https.createServer({ key, cert }, async (req, res) => {
      const url = new URL(req.url, `https://${req.headers.host}`);
      if (url.pathname === "/.well-known/openid-configuration") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          issuer: fakeIdpUrl,
          authorization_endpoint: `${fakeIdpUrl}/authorize`,
          token_endpoint: `${fakeIdpUrl}/token`,
          jwks_uri: `${fakeIdpUrl}/jwks`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["HS256"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["client_secret_post"],
        }));
        return;
      }
      if (url.pathname === "/token" && req.method === "POST") {
        const idToken = await new SignJWT({ email: USER_EMAIL })
          .setProtectedHeader({ alg: "HS256" })
          .setIssuedAt()
          .setIssuer(fakeIdpUrl)
          .setAudience(CLIENT_ID)
          .setSubject(USER_SUB)
          .setExpirationTime("5m")
          .sign(new TextEncoder().encode(CLIENT_SECRET));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          access_token: "fake-access-token",
          token_type: "Bearer",
          expires_in: 3600,
          id_token: idToken,
        }));
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, "127.0.0.1", () => {
      fakeIdpUrl = `https://127.0.0.1:${server.address().port}`;
      resolve(server);
    });
  });
}

const buildApp = () => {
  const a = express();
  a.use(cookieParser());
  a.use("/api/auth", require("../../src/api/authProviders/oidc"));
  // eslint-disable-next-line no-unused-vars
  a.use((err, _req, res, _next) => res.status(500).json({ error: "internal_error", message: err.message }));
  return a;
};

before(async () => {
  origTlsReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // self-signed fake IDP cert only
  fakeIdp = await startFakeIdp();
  process.env.ARBR_AUTH_MODE = "oidc";
  process.env.ARBR_OIDC_ISSUER = fakeIdpUrl;
  process.env.ARBR_OIDC_CLIENT_ID = CLIENT_ID;
  process.env.ARBR_OIDC_CLIENT_SECRET = CLIENT_SECRET;
  process.env.ARBR_OIDC_REDIRECT_URI = REDIRECT_URI;
  delete require.cache[require.resolve("../../src/config")];
  delete require.cache[require.resolve("../../src/api/authProviders/oidc")];

  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  agent = supertest(buildApp());
});

after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
  await new Promise((resolve) => fakeIdp.close(resolve));
  if (origTlsReject === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  else process.env.NODE_TLS_REJECT_UNAUTHORIZED = origTlsReject;
});

const User = require("../../src/models/User");
const Session = require("../../src/models/Session");
beforeEach(async () => { await Promise.all([User.deleteMany({}), Session.deleteMany({})]); });

test("GET /login performs real discovery and redirects to the IdP's authorization endpoint", async () => {
  const res = await agent.get("/api/auth/login");
  assert.equal(res.status, 302);
  const location = new URL(res.headers.location);
  assert.equal(location.origin, fakeIdpUrl);
  assert.equal(location.pathname, "/authorize");
  assert.equal(location.searchParams.get("client_id"), CLIENT_ID);
  assert.equal(location.searchParams.get("redirect_uri"), REDIRECT_URI);
  assert.equal(location.searchParams.get("code_challenge_method"), "S256");
  assert.ok(location.searchParams.get("state"), "expected a state param");
  assert.ok(location.searchParams.get("code_challenge"), "expected a PKCE code_challenge");

  const pendingCookie = res.headers["set-cookie"].find((c) => c.startsWith("arbr_oidc_pending="));
  assert.ok(pendingCookie, "expected the pending-auth cookie to be set");
});

test("GET /callback exchanges the code via the real token endpoint and creates a session", async () => {
  const loginRes = await agent.get("/api/auth/login");
  const location = new URL(loginRes.headers.location);
  const state = location.searchParams.get("state");
  const pendingCookie = loginRes.headers["set-cookie"].find((c) => c.startsWith("arbr_oidc_pending="));

  const callbackRes = await agent
    .get("/api/auth/callback")
    .set("Cookie", pendingCookie.split(";")[0])
    .query({ code: "fake-authorization-code", state });

  assert.equal(callbackRes.status, 302);
  assert.equal(callbackRes.headers.location, "/");

  const sessionCookie = callbackRes.headers["set-cookie"].find((c) => c.startsWith("arbr_session="));
  assert.ok(sessionCookie, "expected a session cookie to be set");

  const user = await User.findOne({ email: USER_EMAIL });
  assert.ok(user, "expected a user to be created from the ID token's email claim");
  assert.equal(user.oidcSubject, USER_SUB);

  const sessionCount = await Session.countDocuments({ userId: user._id });
  assert.equal(sessionCount, 1);
});

test("GET /callback rejects a state that doesn't match the pending cookie", async () => {
  const loginRes = await agent.get("/api/auth/login");
  const pendingCookie = loginRes.headers["set-cookie"].find((c) => c.startsWith("arbr_oidc_pending="));

  const res = await agent
    .get("/api/auth/callback")
    .set("Cookie", pendingCookie.split(";")[0])
    .query({ code: "fake-authorization-code", state: "wrong-state" });

  assert.equal(res.status, 400);
  assert.match(res.text, /state mismatch/i);
});

test("GET /callback without a pending cookie fails cleanly instead of crashing", async () => {
  const res = await agent.get("/api/auth/callback").query({ code: "x", state: "y" });
  assert.equal(res.status, 400);
  assert.match(res.text, /expired/i);
});
