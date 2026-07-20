"use strict";
// The admin API previously had no rate limiting at all (flagged by CodeQL
// js/missing-rate-limiting across every route handler). This exercises the
// fix: a per-source-IP guardrail (express-rate-limit) mounted ahead of
// admin auth.
const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const supertest = require("supertest");

const adminRateLimit = require("../../src/api/adminRateLimit");
const { config } = require("../../src/config");

let agent;

before(() => {
  const app = express();
  app.use(adminRateLimit.middleware, (_req, res) => res.json({ ok: true }));
  agent = supertest(app);
});

test("requests pass under the guardrail", async () => {
  adminRateLimit.middleware.resetKey("::ffff:127.0.0.1");
  const res = await agent.get("/anything");
  assert.equal(res.status, 200);
});

test("429s once the per-IP guardrail is exceeded", async (t) => {
  const original = config.adminRpmGuardrail;
  config.adminRpmGuardrail = 2;
  adminRateLimit.middleware.resetKey("::ffff:127.0.0.1");
  t.after(() => { config.adminRpmGuardrail = original; });

  await agent.get("/anything");
  await agent.get("/anything");
  const third = await agent.get("/anything");
  assert.equal(third.status, 429);
  assert.equal(third.body.error, "rate_limited");
});
