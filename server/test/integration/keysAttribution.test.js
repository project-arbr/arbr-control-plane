"use strict";
// Regression coverage for two breakages introduced by the routes-split landing:
// 1. userId/department attribution dropped from the key routes (PR #131 content).
// 2. resolveKey (WS auth path) called async overRpmLimit without await — the
//    pending Promise is always truthy, so every keyed WS request threw 429.
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
// Tests mount apiRoutes directly (bypassing adminAuth.middleware), so req.user
// must be stubbed the same way adminAuth would set it in adminkey/master-key mode.
const stubAdmin = (req, _res, next) => { req.user = { id: "test", email: "test-admin@test", role: "administrator" }; next(); };
const buildApp = () => { const a = express(); a.use(express.json()); a.use(stubAdmin); a.use("/api", apiRoutes); return a; };

before(async () => { mongod = await MongoMemoryServer.create(); await mongoose.connect(mongod.getUri()); agent = supertest(buildApp()); });
after(async () => { await mongoose.disconnect(); await mongod.stop(); });
beforeEach(async () => { await ApiKey.deleteMany({}); auth.invalidate(); });

test("create accepts and returns userId/department; list keeps them", async () => {
  const res = await agent.post("/api/keys").send({ name: "k", application: "app-a", userId: "u-42", department: "support" });
  assert.equal(res.status, 200);
  assert.equal(res.body.userId, "u-42");
  assert.equal(res.body.department, "support");
  const list = await agent.get("/api/keys");
  assert.equal(list.body[0].userId, "u-42");
  assert.equal(list.body[0].department, "support");
});

test("PATCH can set and clear userId/department", async () => {
  const res = await agent.post("/api/keys").send({ name: "k", application: "app-a" });
  const set = await agent.patch(`/api/keys/${res.body._id}`).send({ userId: "u-9", department: "eng" });
  assert.equal(set.body.userId, "u-9");
  assert.equal(set.body.department, "eng");
  const clear = await agent.patch(`/api/keys/${res.body._id}`).send({ userId: null, department: null });
  assert.equal(clear.body.userId, null);
  assert.equal(clear.body.department, null);
});

test("resolveKey passes a valid key instead of always throwing 429", async () => {
  const res = await agent.post("/api/keys").send({ name: "ws", application: "app-a" });
  auth.invalidate();
  const doc = await auth.resolveKey(`Bearer ${res.body.key}`);
  assert.equal(doc.name, "ws");
  assert.equal(doc.application, "app-a");
});
