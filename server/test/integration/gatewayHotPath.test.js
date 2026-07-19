"use strict";
/**
 * Hot-path integration: auth, caps, shared rate limit, fallback order wiring.
 * Uses MongoMemoryServer when available; skips cleanly if the binary cannot start
 * (some CI/macOS environments SIGABRT the bundled mongod).
 */
const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const mongoose = require("mongoose");
const crypto = require("crypto");

let mongod, agent, skip = false;

before(async () => {
  try {
    // Prefer an explicit / local test DB. MongoMemoryServer SIGABRTs on some macOS hosts
    // and can leave uncaught exceptions that hang the runner.
    const uri = process.env.MONGO_URI_TEST || "mongodb://127.0.0.1:27017/arbr-hotpath-test";
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 3000 });
    const db = mongoose.connection.db;
    for (const name of ["apikeys", "caps", "cap_spends", "rate_buckets", "settings"]) {
      await db.collection(name).deleteMany({}).catch(() => {});
    }
  } catch (err) {
    skip = true;
    console.warn("[gatewayHotPath] skipping — no Mongo available:", err.message);
    return;
  }

  process.env.ARBR_ADMIN_KEY = "";
  // Import after mongo is up so models can connect.
  const auth = require("../../src/gateway/auth");
  const apiRoutes = require("../../src/api/routes");
  const Cap = require("../../src/models/Cap");
  const CapSpend = require("../../src/models/CapSpend");
  const ApiKey = require("../../src/models/ApiKey");
  const Settings = require("../../src/models/Settings");
  const capEngine = require("../../src/routing/capEngine");
  const { overRpmLimit, _resetMemory } = require("../../src/routing/rateLimit");
  const { buildFallbackOrder } = require("../../src/gateway/core");
  const supertest = require("supertest");

  // Seed settings open for admin API.
  await Settings.deleteMany({});
  await Cap.deleteMany({});
  await CapSpend.deleteMany({});
  await ApiKey.deleteMany({});

  const app = express();
  app.use(express.json());
  app.use("/api", apiRoutes);
  // Minimal data-plane auth surface for testing.
  app.post("/v1/echo", auth.middleware, (req, res) => {
    res.json({ ok: true, application: req.apiKey?.application || null });
  });

  agent = supertest(app);

  // Stash helpers on global for tests (scoped to this file via closure vars).
  global.__hot = { Cap, CapSpend, ApiKey, Settings, capEngine, overRpmLimit, _resetMemory, buildFallbackOrder, auth };
});

after(async () => {
  if (mongoose.connection.readyState) {
    await mongoose.disconnect().catch(() => {});
  }
});

function maybeSkip(t) {
  if (skip) {
    t.skip("MongoMemoryServer unavailable");
    return true;
  }
  return false;
}

test("GET /api/about works after routes split", async (t) => {
  if (maybeSkip(t)) return;
  const res = await agent.get("/api/about");
  assert.equal(res.status, 200);
  assert.ok(res.body.version);
});

test("requireApiKey blocks anonymous /v1 when enabled", async (t) => {
  if (maybeSkip(t)) return;
  const { Settings, auth } = global.__hot;
  await auth.setRequireApiKey(true);
  const res = await agent.post("/v1/echo").send({});
  assert.equal(res.status, 401);
  assert.equal(res.body.error, "invalid_api_key");
  await auth.setRequireApiKey(false);
});

test("valid API key authenticates and binds application", async (t) => {
  if (maybeSkip(t)) return;
  const { ApiKey, auth } = global.__hot;
  const raw = "ab_test_" + crypto.randomBytes(8).toString("hex");
  await ApiKey.create({
    name: "hot-path",
    keyHash: auth.hashKey(raw),
    prefix: raw.slice(0, 10),
    application: "billing-app",
    enabled: true,
    rpm: 1000,
  });
  auth.invalidate();
  await auth.setRequireApiKey(true);
  const res = await agent
    .post("/v1/echo")
    .set("Authorization", `Bearer ${raw}`)
    .send({});
  assert.equal(res.status, 200);
  assert.equal(res.body.application, "billing-app");
  await auth.setRequireApiKey(false);
});

test("hard CapSpend counters enforce block action", async (t) => {
  if (maybeSkip(t)) return;
  const { Cap, CapSpend, capEngine } = global.__hot;
  const cap = await Cap.create({
    dimension: null,
    value: null,
    period: "day",
    limit: 1.0,
    action: "block",
    enabled: true,
  });
  capEngine.invalidate();
  const key = capEngine.windowKey("day");
  await CapSpend.create({ capId: cap._id, windowKey: key, spent: 1.5 });
  const enf = await capEngine.enforcement({ application: "any", provider: "openai" });
  assert.ok(enf);
  assert.equal(enf.action, "block");
  await Cap.deleteMany({});
  await CapSpend.deleteMany({});
  capEngine.invalidate();
});

test("recordSpend increments CapSpend atomically", async (t) => {
  if (maybeSkip(t)) return;
  const { Cap, CapSpend, capEngine } = global.__hot;
  const cap = await Cap.create({
    dimension: "application",
    value: "spend-app",
    period: "day",
    limit: 100,
    action: "downgrade",
    enabled: true,
  });
  capEngine.invalidate();
  await capEngine.recordSpend(2.5, { application: "spend-app", provider: "openai" });
  await capEngine.recordSpend(1.5, { application: "spend-app", provider: "openai" });
  const spent = await capEngine.getSpend(cap.toObject());
  assert.ok(spent >= 4.0 - 0.001);
  await Cap.deleteMany({});
  await CapSpend.deleteMany({});
  capEngine.invalidate();
});

test("shared rate limit overRpmLimit trips after rpm", async (t) => {
  if (maybeSkip(t)) return;
  const { overRpmLimit } = global.__hot;
  const key = "test:" + crypto.randomBytes(4).toString("hex");
  assert.equal(await overRpmLimit(key, 2), false);
  assert.equal(await overRpmLimit(key, 2), false);
  assert.equal(await overRpmLimit(key, 2), true);
});

test("core exports unified buildFallbackOrder (same-provider default)", async (t) => {
  if (maybeSkip(t)) return;
  const { buildFallbackOrder } = global.__hot;
  const order = buildFallbackOrder(
    "openai",
    "gpt-4o",
    ["openai", "anthropic"],
    { openai: "gpt-4o-mini", anthropic: "claude-haiku-4-5" },
    "same-provider"
  );
  assert.equal(order.length, 2);
  assert.equal(order[1].provider, "openai");
});
