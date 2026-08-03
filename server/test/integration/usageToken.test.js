"use strict";
// Integration: the scoped read-only usage token (#2 keystone).
// Proves a "read" token sees ONLY its own application (+ user) analytics, cannot
// widen its scope via query params, is rejected on the data plane, and that a normal
// gateway key is rejected on /v1/usage. Uses MongoMemoryServer; skips if unavailable.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

let mongod, skip = false;
let agent, RAW = {};

before(async () => {
  try {
    const { MongoMemoryServer } = require("mongodb-memory-server");
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
  } catch (err) {
    skip = true;
    console.warn("[usageToken] skipping — no in-memory Mongo:", err.message);
    return;
  }
  const express = require("express");
  const supertest = require("supertest");
  const ApiKey = require("../../src/models/ApiKey");
  const RequestRecord = require("../../src/models/RequestRecord");
  const auth = require("../../src/gateway/auth");
  const readTokenAuth = require("../../src/gateway/readTokenAuth");
  const usageRoutes = require("../../src/api/routes/usage");

  await ApiKey.deleteMany({});
  await RequestRecord.deleteMany({});

  // A read token scoped to acme / userA, a read token scoped to acme (app-wide),
  // and a normal gateway key. Create with known secrets via hashKey.
  RAW = { userA: "ab_read_" + "a".repeat(32), app: "ab_read_" + "b".repeat(32), gw: "ab_" + "c".repeat(32) };
  await ApiKey.create([
    { name: "userA usage", application: "acme", kind: "read", userId: "userA", keyHash: auth.hashKey(RAW.userA), prefix: "ab_read_…aaaa" },
    { name: "acme usage", application: "acme", kind: "read", keyHash: auth.hashKey(RAW.app), prefix: "ab_read_…bbbb" },
    { name: "acme gateway", application: "acme", kind: "gateway", keyHash: auth.hashKey(RAW.gw), prefix: "ab_…cccc" },
  ]);
  // Customer records: userA spent $3 on acme, userB spent $7 on acme, and another
  // app "other" spent $99. internalKind null = customer traffic (counts in overview).
  await RequestRecord.create([
    { requestId: "r1", application: "acme", userId: "userA", model: "gpt-4o", totalCost: 3, totalTokens: 100, status: "success", internalKind: null },
    { requestId: "r2", application: "acme", userId: "userB", model: "gpt-4o", totalCost: 7, totalTokens: 200, status: "success", internalKind: null },
    { requestId: "r3", application: "other", userId: "userC", model: "gpt-4o", totalCost: 99, totalTokens: 900, status: "success", internalKind: null },
  ]);

  const app = express();
  app.use(express.json());
  app.use("/v1/usage", readTokenAuth.middleware, usageRoutes);
  // Minimal data-plane surface: just the auth guard, then OK.
  app.post("/v1/chat", auth.middleware, (req, res) => res.json({ ok: true }));
  agent = supertest(app);
});

after(async () => {
  if (skip) return;
  await mongoose.disconnect();
  await mongod.stop();
});

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

test("a user-scoped read token sees ONLY its own user's spend", async (t) => {
  if (skip) return t.skip("no mongo");
  const res = await agent.get("/v1/usage/overview").set(bearer(RAW.userA));
  assert.equal(res.status, 200);
  assert.equal(res.body.totalCost, 3, "userA sees only their $3, not userB's $7 or other-app's $99");
});

test("an app-scoped read token sees the whole application, not other apps", async (t) => {
  if (skip) return t.skip("no mongo");
  const res = await agent.get("/v1/usage/overview").set(bearer(RAW.app));
  assert.equal(res.status, 200);
  assert.equal(res.body.totalCost, 10, "acme app = $3 + $7, excludes other-app's $99");
});

test("scope cannot be widened via query params (forced from the token)", async (t) => {
  if (skip) return t.skip("no mongo");
  // Try to read another app / user — the endpoint ignores query and uses the token scope.
  const res = await agent.get("/v1/usage/overview?application=other&userId=userB").set(bearer(RAW.userA));
  assert.equal(res.status, 200);
  assert.equal(res.body.totalCost, 3, "query params must not override the token's scope");
});

test("the scope endpoint reports the token's own scope", async (t) => {
  if (skip) return t.skip("no mongo");
  const res = await agent.get("/v1/usage/scope").set(bearer(RAW.userA));
  assert.deepEqual(res.body, { application: "acme", userId: "userA" });
});

test("a read token is rejected on the data plane (/v1/chat)", async (t) => {
  if (skip) return t.skip("no mongo");
  const res = await agent.post("/v1/chat").set(bearer(RAW.userA)).send({ messages: [] });
  assert.equal(res.status, 401);
  assert.equal(res.body.error, "read_token_on_data_plane");
});

test("a gateway key is rejected on /v1/usage", async (t) => {
  if (skip) return t.skip("no mongo");
  const res = await agent.get("/v1/usage/overview").set(bearer(RAW.gw));
  assert.equal(res.status, 401);
  assert.equal(res.body.error, "invalid_read_token");
});

test("no token is rejected on /v1/usage", async (t) => {
  if (skip) return t.skip("no mongo");
  const res = await agent.get("/v1/usage/overview");
  assert.equal(res.status, 401);
});
