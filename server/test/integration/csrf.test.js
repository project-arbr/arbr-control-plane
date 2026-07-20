"use strict";
// CSRF protection (server/src/api/csrf.js): a session-cookie-authenticated
// mutation must carry a valid x-csrf-token, but adminkey-mode (Bearer auth,
// no cookie) is unaffected — a forged cross-site request can't attach a
// custom Authorization header the way a cookie is attached automatically.
process.env.ARBR_ADMIN_KEY = "test-master-key"; // break-glass credential, works in every auth mode
process.env.ARBR_AUTH_MODE = "oidc";
process.env.ARBR_OIDC_ISSUER = "https://issuer.example.test";
process.env.ARBR_OIDC_CLIENT_ID = "test-client";
process.env.ARBR_OIDC_CLIENT_SECRET = "test-secret";
process.env.ARBR_OIDC_REDIRECT_URI = "http://localhost/api/auth/callback";

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { MongoMemoryServer } = require("mongodb-memory-server");
const mongoose = require("mongoose");
const express = require("express");
const cookieParser = require("cookie-parser");
const supertest = require("supertest");

const csrf = require("../../src/api/csrf");
const adminAuth = require("../../src/api/adminAuth");
const apiRoutes = require("../../src/api/routes");
const authRoutes = require("../../src/api/routes/auth");
const User = require("../../src/models/User");
const Session = require("../../src/models/Session");

let mongod, agent;

// Mirrors the real mount order in server/src/index.js: cookieParser → csrf →
// auth routes (unauthenticated) → adminAuth (sets req.user from the cookie) → apiRoutes.
const buildApp = () => {
  const a = express();
  a.use(express.json());
  a.use(cookieParser());
  a.use(csrf.protection);
  a.use("/api/auth", authRoutes);
  a.use("/api", adminAuth.middleware, apiRoutes);
  // eslint-disable-next-line no-unused-vars
  a.use((err, _req, res, _next) => res.status(err.status || err.statusCode || 500).json({ error: err.code || "internal_error" }));
  return a;
};

before(async () => { mongod = await MongoMemoryServer.create(); await mongoose.connect(mongod.getUri()); agent = supertest(buildApp()); });
after(async () => { await mongoose.disconnect(); await mongod.stop(); });
beforeEach(async () => { await Promise.all([User.deleteMany({}), Session.deleteMany({})]); });

async function createSession(role = "administrator") {
  const user = await User.create({ email: `${role}@test`, role });
  const sessionId = `sess-${user._id}`;
  await Session.create({ _id: sessionId, userId: user._id, expiresAt: new Date(Date.now() + 3600_000) });
  return `arbr_session=${sessionId}`;
}

test("a session-cookie mutation without a CSRF token is rejected", async () => {
  const cookie = await createSession();
  const res = await agent.post("/api/caps").set("Cookie", cookie).send({ limit: 5 });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, "EBADCSRFTOKEN");
});

test("a session-cookie mutation with a matching CSRF token succeeds", async () => {
  const cookie = await createSession();
  const tokenRes = await agent.get("/api/auth/csrf").set("Cookie", cookie);
  const csrfCookie = tokenRes.headers["set-cookie"].find((c) => c.startsWith("arbr_csrf="));
  assert.ok(csrfCookie, "expected the server to set a csrf cookie");

  const res = await agent
    .post("/api/caps")
    .set("Cookie", [cookie, csrfCookie.split(";")[0]].join("; "))
    .set("x-csrf-token", tokenRes.body.csrfToken)
    .send({ limit: 5 });
  assert.equal(res.status, 200);
});

test("a mismatched CSRF token is rejected", async () => {
  const cookie = await createSession();
  const tokenRes = await agent.get("/api/auth/csrf").set("Cookie", cookie);
  const csrfCookie = tokenRes.headers["set-cookie"].find((c) => c.startsWith("arbr_csrf="));

  const res = await agent
    .post("/api/caps")
    .set("Cookie", [cookie, csrfCookie.split(";")[0]].join("; "))
    .set("x-csrf-token", "not-the-right-token")
    .send({ limit: 5 });
  assert.equal(res.status, 403);
});

test("the master-key break-glass credential (Bearer, no session cookie) needs no CSRF token", async () => {
  const res = await agent
    .post("/api/caps")
    .set("Authorization", "Bearer test-master-key")
    .send({ limit: 5 });
  assert.equal(res.status, 200);
});
