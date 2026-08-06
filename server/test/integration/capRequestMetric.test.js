"use strict";
// Request-count caps: a cap with metric:"requests" enforces a raw request quota (e.g. a
// free-tier "N requests / month") instead of a USD budget. recordRequest() counts every
// successful customer-facing request — including $0 / cached ones — while recordSpend()
// keeps counting only priced spend. The two metrics never cross-contaminate each other's
// counters, and Arbr's own internal overhead never burns a request quota.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { MongoMemoryServer } = require("mongodb-memory-server");
const mongoose = require("mongoose");

const Cap = require("../../src/models/Cap");
const CapSpend = require("../../src/models/CapSpend");
const capEngine = require("../../src/routing/capEngine");

let mongod;

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});

after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Cap.deleteMany({});
  await CapSpend.deleteMany({});
  capEngine.invalidate(); // drop the 5s cap-list cache so freshly-created caps are seen
});

const ctx = (over = {}) => ({ application: "chat", provider: "openai", ...over });

test("request cap blocks after exactly `limit` successful requests", async () => {
  await Cap.create({ dimension: null, metric: "requests", period: "month", limit: 3, action: "block" });
  capEngine.invalidate();

  assert.equal((await capEngine.enforcement(ctx())), null, "under quota: no enforcement");
  await capEngine.recordRequest(ctx());
  await capEngine.recordRequest(ctx());
  assert.equal((await capEngine.enforcement(ctx())), null, "2/3 used: still allowed");

  await capEngine.recordRequest(ctx()); // 3rd — reaches the limit
  const enf = await capEngine.enforcement(ctx());
  assert.equal(enf?.action, "block", "at quota: request is blocked");
  assert.equal(enf.spent, 3);
});

test("request cap counts $0 / cached requests (independent of cost)", async () => {
  await Cap.create({ dimension: null, metric: "requests", period: "month", limit: 2, action: "block" });
  capEngine.invalidate();

  // recordSpend for a $0 request is a no-op; recordRequest must still count it.
  await capEngine.recordSpend(0, ctx());
  await capEngine.recordRequest(ctx());
  await capEngine.recordRequest(ctx());

  const enf = await capEngine.enforcement(ctx());
  assert.equal(enf?.action, "block", "two $0 requests still exhaust a 2-request quota");
});

test("request cap never counts Arbr's own internal overhead", async () => {
  await Cap.create({ dimension: null, metric: "requests", period: "month", limit: 2, action: "block" });
  capEngine.invalidate();

  await capEngine.recordRequest(ctx({ internalKind: "classifier", application: null }));
  await capEngine.recordRequest(ctx({ internalKind: "eval", application: null }));
  assert.equal((await capEngine.enforcement(ctx())), null, "internal calls did not burn the quota");

  await capEngine.recordRequest(ctx());
  await capEngine.recordRequest(ctx());
  assert.equal((await capEngine.enforcement(ctx()))?.action, "block", "only customer requests count");
});

test("spend and request metrics keep separate counters", async () => {
  const spendCap = await Cap.create({ dimension: null, metric: "spend", period: "month", limit: 10, action: "block" });
  const reqCap = await Cap.create({ dimension: null, metric: "requests", period: "month", limit: 5, action: "block" });
  capEngine.invalidate();

  // A priced request: recordSpend bumps the spend cap; recordRequest bumps the request cap.
  await capEngine.recordSpend(4, ctx());   // spend: 4/10
  await capEngine.recordRequest(ctx());    // requests: 1/5

  assert.equal(await capEngine.getSpend(spendCap), 4, "spend counter got the dollars, not +1");
  assert.equal(await capEngine.getSpend(reqCap), 1, "request counter got +1, not the dollars");

  // Neither is at its limit yet.
  assert.equal(await capEngine.enforcement(ctx()), null);
});

test("legacy caps with no metric behave as spend caps (backward compatible)", async () => {
  // Simulate a pre-existing cap written before `metric` existed.
  await Cap.collection.insertOne({
    dimension: null, period: "month", limit: 5, action: "block",
    warningThreshold: 0.8, enabled: true, createdAt: new Date(),
  });
  capEngine.invalidate();

  await capEngine.recordRequest(ctx()); // must NOT touch a spend cap
  assert.equal(await capEngine.enforcement(ctx()), null, "recordRequest left the spend cap untouched");

  await capEngine.recordSpend(5, ctx()); // dollars do count
  assert.equal((await capEngine.enforcement(ctx()))?.action, "block");
});
