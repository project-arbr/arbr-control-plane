"use strict";
// The admin API previously had no rate limiting at all (flagged by CodeQL
// js/missing-rate-limiting across every route handler). This exercises the
// fix: a per-source-IP guardrail mounted ahead of admin auth.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { MongoMemoryServer } = require("mongodb-memory-server");
const mongoose = require("mongoose");
const express = require("express");
const supertest = require("supertest");

process.env.ARBR_ADMIN_KEY = "";

const RateBucket = require("../../src/models/RateBucket");
const adminRateLimit = require("../../src/api/adminRateLimit");
const { config } = require("../../src/config");

let mongod, agent;

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  const app = express();
  app.use(adminRateLimit.middleware, (_req, res) => res.json({ ok: true }));
  agent = supertest(app);
});
after(async () => { await mongoose.disconnect(); await mongod.stop(); });
beforeEach(async () => { await RateBucket.deleteMany({}); });

test("requests pass under the guardrail", async () => {
  const res = await agent.get("/anything");
  assert.equal(res.status, 200);
});

test("429s once the per-IP guardrail is exceeded", async (t) => {
  const original = config.adminRpmGuardrail;
  config.adminRpmGuardrail = 2;
  t.after(() => { config.adminRpmGuardrail = original; });

  await agent.get("/anything");
  await agent.get("/anything");
  const third = await agent.get("/anything");
  assert.equal(third.status, 429);
  assert.equal(third.body.error, "rate_limited");
});
