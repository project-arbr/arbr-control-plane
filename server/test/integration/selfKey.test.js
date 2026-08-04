"use strict";
// Integration: self-service key management (#3). A key's own holder can view, rotate,
// and revoke it with the key itself as proof of possession — no admin role. Rotation
// preserves kind + scope and invalidates the old key. Uses MongoMemoryServer.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

let mongod, skip = false, agent, ApiKey, auth, RAW = {};

before(async () => {
  try {
    const { MongoMemoryServer } = require("mongodb-memory-server");
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
  } catch (err) { skip = true; console.warn("[selfKey] skipping — no mongo:", err.message); return; }
  const express = require("express");
  const supertest = require("supertest");
  ApiKey = require("../../src/models/ApiKey");
  auth = require("../../src/gateway/auth");
  const selfKeyAuth = require("../../src/gateway/selfKeyAuth");
  const selfKeyRoutes = require("../../src/api/routes/selfKey");

  await ApiKey.deleteMany({});
  RAW = { gw: "ab_" + "a".repeat(32), read: "ab_read_" + "b".repeat(32) };
  await ApiKey.create([
    { name: "gw", application: "acme", kind: "gateway", userId: "alice", rpm: 60, keyHash: auth.hashKey(RAW.gw), prefix: "ab_…aaaa" },
    { name: "usage", application: "acme", kind: "read", userId: "alice", keyHash: auth.hashKey(RAW.read), prefix: "ab_read_…bbbb" },
  ]);

  const app = express();
  app.use(express.json());
  app.use("/v1/key", selfKeyAuth.middleware, selfKeyRoutes);
  agent = supertest(app);
});

after(async () => { if (skip) return; await mongoose.disconnect(); await mongod.stop(); });

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

test("GET /v1/key returns the caller's own key metadata", async (t) => {
  if (skip) return t.skip("no mongo");
  const res = await agent.get("/v1/key").set(bearer(RAW.gw));
  assert.equal(res.status, 200);
  assert.equal(res.body.application, "acme");
  assert.equal(res.body.kind, "gateway");
});

test("no key is 401", async (t) => {
  if (skip) return t.skip("no mongo");
  assert.equal((await agent.get("/v1/key")).status, 401);
});

test("rotating a READ token preserves kind + scope and returns a read secret", async (t) => {
  if (skip) return t.skip("no mongo");
  const res = await agent.post("/v1/key/rotate").set(bearer(RAW.read));
  assert.equal(res.status, 200);
  assert.equal(res.body.kind, "read", "rotation must NOT downgrade a read token to gateway");
  assert.equal(res.body.application, "acme");
  assert.equal(res.body.userId, "alice");
  assert.ok(res.body.key.startsWith("ab_read_"), "new secret keeps the read prefix");
  // The OLD read token no longer authenticates.
  auth.invalidate();
  assert.equal((await agent.get("/v1/key").set(bearer(RAW.read))).status, 401);
  // The NEW one does, and is still a read token.
  const again = await agent.get("/v1/key").set(bearer(res.body.key));
  assert.equal(again.body.kind, "read");
});

test("rotating a GATEWAY key preserves its settings", async (t) => {
  if (skip) return t.skip("no mongo");
  const res = await agent.post("/v1/key/rotate").set(bearer(RAW.gw));
  assert.equal(res.status, 200);
  assert.equal(res.body.kind, "gateway");
  assert.ok(res.body.key.startsWith("ab_") && !res.body.key.startsWith("ab_read_"));
  RAW.gw = res.body.key; // keep for the revoke test
});

test("self-revoke disables the key immediately", async (t) => {
  if (skip) return t.skip("no mongo");
  const res = await agent.post("/v1/key/revoke").set(bearer(RAW.gw));
  assert.equal(res.status, 200);
  assert.equal(res.body.revoked, true);
  auth.invalidate();
  assert.equal((await agent.get("/v1/key").set(bearer(RAW.gw))).status, 401);
});
