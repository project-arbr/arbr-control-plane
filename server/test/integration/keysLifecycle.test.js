"use strict";
// Key lifecycle: create with attribution + expiry, expired-key rejection on the
// data plane, rotation preserving settings, PATCH updates.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { MongoMemoryServer } = require("mongodb-memory-server");
const mongoose = require("mongoose");
const express = require("express");
const supertest = require("supertest");

process.env.ARBR_ADMIN_KEY = "";

const ApiKey = require("../../src/models/ApiKey");
const auth = require("../../src/gateway/auth");
const apiRoutes = require("../../src/api/routes");

let mongod, agent;
const buildApp = () => {
  const a = express();
  a.use(express.json());
  a.use("/api", apiRoutes);
  // Minimal data-plane surface to exercise the auth middleware.
  a.post("/v1/echo", auth.middleware, (req, res) => res.json({ ok: true, application: req.apiKey?.application || null }));
  return a;
};

before(async () => { mongod = await MongoMemoryServer.create(); await mongoose.connect(mongod.getUri()); agent = supertest(buildApp()); });
after(async () => { await mongoose.disconnect(); await mongod.stop(); });
beforeEach(async () => { await ApiKey.deleteMany({}); auth.invalidate(); });

const create = (body) => agent.post("/api/keys").send({ name: "k", application: "app-a", ...body });

test("create returns attribution + expiry in the key view", async () => {
  const res = await create({ userId: "u-42", department: "support", expiresAt: "2030-01-01" });
  assert.equal(res.status, 200);
  assert.equal(res.body.userId, "u-42");
  assert.equal(res.body.department, "support");
  assert.ok(res.body.expiresAt);
  assert.match(res.body.key, /^ab_/);
  // and the list view keeps them
  const list = await agent.get("/api/keys");
  assert.equal(list.body[0].userId, "u-42");
  assert.equal(list.body[0].department, "support");
});

test("expired key is rejected on the data plane with expired_api_key", async () => {
  const res = await create({ expiresAt: "2020-01-01" });
  const echo = await agent.post("/v1/echo").set("Authorization", `Bearer ${res.body.key}`).send({});
  assert.equal(echo.status, 401);
  assert.equal(echo.body.error, "expired_api_key");
});

test("unexpired and no-expiry keys pass the data plane", async () => {
  const future = await create({ expiresAt: "2030-01-01" });
  const never = await create({ name: "k2", application: "app-b" });
  for (const key of [future.body.key, never.body.key]) {
    const echo = await agent.post("/v1/echo").set("Authorization", `Bearer ${key}`).send({});
    assert.equal(echo.status, 200);
  }
});

test("resolveKey (WS path) rejects expired keys and passes valid ones", async () => {
  const good = await create({ name: "ws-good", expiresAt: "2030-01-01" });
  const bad = await create({ name: "ws-bad", application: "app-b", expiresAt: "2020-01-01" });
  auth.invalidate();
  const doc = await auth.resolveKey(`Bearer ${good.body.key}`);
  assert.equal(doc.name, "ws-good");
  await assert.rejects(() => auth.resolveKey(`Bearer ${bad.body.key}`), (e) => e.statusCode === 401);
});

test("rotate revokes the old key and preserves settings on the new one", async () => {
  const res = await create({ userId: "u-42", department: "support", expiresAt: "2030-01-01", rpm: 5 });
  const rot = await agent.post(`/api/keys/${res.body._id}/rotate`).send({});
  assert.equal(rot.status, 200);
  assert.match(rot.body.key, /^ab_/);
  assert.notEqual(rot.body.key, res.body.key);
  assert.equal(rot.body.userId, "u-42");
  assert.equal(rot.body.department, "support");
  assert.equal(rot.body.rpm, 5);
  assert.ok(rot.body.expiresAt);
  // old key no longer authenticates; new one does
  const oldEcho = await agent.post("/v1/echo").set("Authorization", `Bearer ${res.body.key}`).send({});
  assert.equal(oldEcho.status, 401);
  const newEcho = await agent.post("/v1/echo").set("Authorization", `Bearer ${rot.body.key}`).send({});
  assert.equal(newEcho.status, 200);
  // old key gone from the list
  const list = await agent.get("/api/keys");
  assert.equal(list.body.length, 1);
  assert.equal(String(list.body[0]._id), String(rot.body._id));
});

test("PATCH can set and clear expiresAt", async () => {
  const res = await create({});
  const set = await agent.patch(`/api/keys/${res.body._id}`).send({ expiresAt: "2030-06-01" });
  assert.ok(set.body.expiresAt);
  const clear = await agent.patch(`/api/keys/${res.body._id}`).send({ expiresAt: null });
  assert.equal(clear.body.expiresAt, null);
});
