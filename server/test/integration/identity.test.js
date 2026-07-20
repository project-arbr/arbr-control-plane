"use strict";
// F-04 (accountable admin access): /api/auth/* endpoints, RBAC gating on
// mutating routes, per-user audit attribution, and user disable revoking
// only that user's sessions.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { MongoMemoryServer } = require("mongodb-memory-server");
const mongoose = require("mongoose");
const express = require("express");
const supertest = require("supertest");

process.env.ARBR_ADMIN_KEY = "";

const apiRoutes = require("../../src/api/routes");
const authRoutes = require("../../src/api/routes/auth");
const AuditLog = require("../../src/models/AuditLog");
const User = require("../../src/models/User");
const Session = require("../../src/models/Session");
const Rule = require("../../src/models/Rule");

let mongod, agent;
// currentTestUser is swapped per-test to exercise each role without a real
// login flow — mirrors what adminAuth.middleware would set as req.user.
let currentTestUser = { id: "admin-1", email: "admin@test", role: "administrator" };
const stubUser = (req, _res, next) => { req.user = currentTestUser; next(); };

const buildApp = () => {
  const a = express();
  a.use(express.json());
  a.use("/api/auth", authRoutes); // unauthenticated — exercises real identity.resolveUser()
  a.use(stubUser);
  a.use("/api", apiRoutes);
  return a;
};

before(async () => { mongod = await MongoMemoryServer.create(); await mongoose.connect(mongod.getUri()); agent = supertest(buildApp()); });
after(async () => { await mongoose.disconnect(); await mongod.stop(); });
beforeEach(async () => {
  currentTestUser = { id: "admin-1", email: "admin@test", role: "administrator" };
  await Promise.all([AuditLog.deleteMany({}), User.deleteMany({}), Session.deleteMany({}), Rule.deleteMany({})]);
});

test("GET /api/auth/mode reports the configured auth mode", async () => {
  const res = await agent.get("/api/auth/mode");
  assert.equal(res.status, 200);
  assert.equal(res.body.mode, "adminkey"); // default in this test env (no ARBR_AUTH_MODE set)
});

test("GET /api/auth/me returns null in adminkey mode (no per-user session)", async () => {
  const res = await agent.get("/api/auth/me");
  assert.equal(res.status, 200);
  assert.equal(res.body.user, null);
});

test("viewer is blocked from an operator-only mutation", async () => {
  currentTestUser = { id: "v-1", email: "viewer@test", role: "viewer" };
  const res = await agent.post("/api/rules").send({ target: { provider: "openai", model: "gpt-4o-mini" } });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, "forbidden");
});

test("operator can mutate operator-level routes but not administrator-only ones", async () => {
  currentTestUser = { id: "o-1", email: "operator@test", role: "operator" };
  const ruleRes = await agent.post("/api/rules").send({ target: { provider: "openai", model: "gpt-4o-mini" } });
  assert.equal(ruleRes.status, 200);

  const govRes = await agent.patch("/api/governance").send({ retentionDays: 30 });
  assert.equal(govRes.status, 403);
});

test("audit entries name the real actor, not a hardcoded default", async () => {
  currentTestUser = { id: "a-42", email: "alice@test", role: "administrator" };
  const res = await agent.post("/api/rules").send({ target: { provider: "openai", model: "gpt-4o-mini" } });
  assert.equal(res.status, 200);

  // logAction fires via setImmediate (fire-and-forget) — poll briefly rather
  // than assume one event-loop tick is enough.
  let entry = null;
  for (let i = 0; i < 20 && !entry; i++) {
    entry = await AuditLog.findOne({ action: "rule.create" }).lean();
    if (!entry) await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(entry, "expected an audit log entry");
  assert.equal(entry.actor.email, "alice@test");
  assert.equal(entry.actor.role, "administrator");
});

test("disabling a user deletes only their sessions, leaving others untouched", async () => {
  const alice = await User.create({ email: "alice2@test", role: "viewer" });
  const bob = await User.create({ email: "bob2@test", role: "viewer" });
  await Session.create({ _id: "sess-alice", userId: alice._id, expiresAt: new Date(Date.now() + 3600_000) });
  await Session.create({ _id: "sess-bob", userId: bob._id, expiresAt: new Date(Date.now() + 3600_000) });

  const res = await agent.post(`/api/users/${alice._id}/disable`);
  assert.equal(res.status, 200);
  assert.ok(res.body.disabledAt);

  assert.equal(await Session.findById("sess-alice"), null);
  assert.ok(await Session.findById("sess-bob"), "bob's session should be untouched");
});

test("an administrator cannot disable themselves", async () => {
  const self = await User.create({ email: "self@test", role: "administrator" });
  currentTestUser = { id: String(self._id), email: self.email, role: "administrator" };
  const res = await agent.post(`/api/users/${self._id}/disable`);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "cannot_disable_self");
});
