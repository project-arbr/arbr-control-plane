"use strict";
// F-01 (observe-only ingestion): POST /v1/ingest accepts request-metadata events
// that already happened elsewhere, with idempotent dedup and no live provider call.
process.env.ARBR_ADMIN_KEY = "";

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { MongoMemoryServer } = require("mongodb-memory-server");
const mongoose = require("mongoose");
const express = require("express");
const supertest = require("supertest");
const crypto = require("crypto");

const auth = require("../../src/gateway/auth");
const { handleIngest } = require("../../src/gateway/ingest");
const ApiKey = require("../../src/models/ApiKey");
const RequestRecord = require("../../src/models/RequestRecord");
const ModelEntry = require("../../src/models/ModelEntry");
const Cap = require("../../src/models/Cap");
const CapSpend = require("../../src/models/CapSpend");
const registry = require("../../src/pricing/registry");
const capEngine = require("../../src/routing/capEngine");
const analytics = require("../../src/analytics/aggregate");

let mongod, agent;

const buildApp = () => {
  const a = express();
  a.use(express.json());
  a.post("/v1/ingest", auth.middleware, handleIngest);
  return a;
};

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  agent = supertest(buildApp());
  await ModelEntry.create({
    id: "gpt-4o-mini", provider: "openai", inputPer1M: 0.15, outputPer1M: 0.6, tier: "light",
  });
  await registry.reload();
});
after(async () => { await mongoose.disconnect(); await mongod.stop(); });
beforeEach(async () => {
  await Promise.all([ApiKey.deleteMany({}), RequestRecord.deleteMany({}), Cap.deleteMany({}), CapSpend.deleteMany({})]);
  auth.invalidate();
  capEngine.invalidate();
});

async function createKey(application = "partner-app") {
  const raw = "ab_" + crypto.randomBytes(16).toString("hex");
  const doc = await ApiKey.create({
    name: "ingest-test", application,
    keyHash: auth.hashKey(raw), prefix: raw.slice(0, 6), enabled: true,
  });
  return { doc, raw };
}

test("rejects a request with no API key", async () => {
  const res = await agent.post("/v1/ingest").send({ events: [{ requestId: "x", model: "gpt-4o-mini" }] });
  assert.equal(res.status, 401);
});

test("rejects an empty or missing events array", async () => {
  const { raw } = await createKey();
  const res = await agent.post("/v1/ingest").set("Authorization", `Bearer ${raw}`).send({ events: [] });
  assert.equal(res.status, 400);
});

test("rejects a batch over the max size", async () => {
  const { raw } = await createKey();
  const events = Array.from({ length: 501 }, (_, i) => ({ requestId: `e${i}`, model: "gpt-4o-mini" }));
  const res = await agent.post("/v1/ingest").set("Authorization", `Bearer ${raw}`).send({ events });
  assert.equal(res.status, 400);
});

test("accepts a batch, deriving cost server-side and defaulting attribution to the key's application", async () => {
  const { raw } = await createKey("partner-app");
  const res = await agent.post("/v1/ingest").set("Authorization", `Bearer ${raw}`).send({
    events: [{ requestId: "ext-1", model: "gpt-4o-mini", promptTokens: 1_000_000, completionTokens: 0, status: "success" }],
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.accepted, ["ext-1"]);
  assert.deepEqual(res.body.duplicates, []);
  assert.deepEqual(res.body.rejected, []);

  const doc = await RequestRecord.findOne({ externalRequestId: "ext-1" }).lean();
  assert.ok(doc, "expected a RequestRecord");
  assert.equal(doc.source, "ingested");
  assert.equal(doc.application, "partner-app");
  assert.equal(doc.routingDecision, "external");
  assert.equal(doc.provider, "openai");
  assert.equal(doc.knownPricing, true);
  assert.ok(doc.totalCost > 0, "cost should be derived from tokens, not trusted as $0");
  assert.notEqual(doc.requestId, "ext-1", "stored requestId must be namespaced, not the raw caller value");
});

test("an unrecognized model is priced at $0 with knownPricing:false, same as live gateway traffic", async () => {
  const { raw } = await createKey();
  const res = await agent.post("/v1/ingest").set("Authorization", `Bearer ${raw}`).send({
    events: [{ requestId: "ext-unknown", model: "totally-made-up-model-xyz", promptTokens: 100 }],
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.accepted, ["ext-unknown"]);
  const doc = await RequestRecord.findOne({ externalRequestId: "ext-unknown" }).lean();
  assert.equal(doc.knownPricing, false);
  assert.equal(doc.totalCost, 0);
  assert.equal(doc.provider, null);
});

test("re-submitting the same requestId is reported as a duplicate, not double-counted", async () => {
  const { raw } = await createKey();
  const event = { requestId: "ext-dup", model: "gpt-4o-mini", promptTokens: 100, completionTokens: 50 };
  const first = await agent.post("/v1/ingest").set("Authorization", `Bearer ${raw}`).send({ events: [event] });
  assert.deepEqual(first.body.accepted, ["ext-dup"]);

  const second = await agent.post("/v1/ingest").set("Authorization", `Bearer ${raw}`).send({ events: [event] });
  assert.deepEqual(second.body.accepted, []);
  assert.deepEqual(second.body.duplicates, ["ext-dup"]);

  const count = await RequestRecord.countDocuments({ externalRequestId: "ext-dup" });
  assert.equal(count, 1, "duplicate submission must not create a second record");
});

test("two different keys can independently use the same caller-chosen requestId", async () => {
  const { raw: rawA } = await createKey("app-a");
  const { raw: rawB } = await createKey("app-b");
  const event = { requestId: "shared-id", model: "gpt-4o-mini" };
  const resA = await agent.post("/v1/ingest").set("Authorization", `Bearer ${rawA}`).send({ events: [event] });
  const resB = await agent.post("/v1/ingest").set("Authorization", `Bearer ${rawB}`).send({ events: [event] });
  assert.deepEqual(resA.body.accepted, ["shared-id"]);
  assert.deepEqual(resB.body.accepted, ["shared-id"], "a different key's namespace must not collide");
  const count = await RequestRecord.countDocuments({ externalRequestId: "shared-id" });
  assert.equal(count, 2);
});

test("a bad event in a batch doesn't fail the rest", async () => {
  const { raw } = await createKey();
  const res = await agent.post("/v1/ingest").set("Authorization", `Bearer ${raw}`).send({
    events: [
      { requestId: "good-1", model: "gpt-4o-mini" },
      { model: "gpt-4o-mini" }, // missing requestId
      { requestId: "good-2", model: "gpt-4o-mini" },
    ],
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.accepted.sort(), ["good-1", "good-2"]);
  assert.equal(res.body.rejected.length, 1);
});

test("ingested spend counts toward a global cap, matching live gateway spend", async () => {
  await Cap.create({ dimension: null, period: "month", limit: 10, action: "block", enabled: true });
  const { raw } = await createKey();
  await agent.post("/v1/ingest").set("Authorization", `Bearer ${raw}`).send({
    events: [{ requestId: "priced", model: "gpt-4o-mini", promptTokens: 1_000_000, completionTokens: 1_000_000, status: "success" }],
  });
  await new Promise((r) => setTimeout(r, 100)); // capEngine.recordSpend runs via setImmediate
  const spend = await CapSpend.findOne({}).lean();
  assert.ok(spend && spend.spent > 0, "expected ingested spend to be recorded against the global cap");
});

test("source is visible by default and filterable via analytics buildMatch", async () => {
  const { raw } = await createKey();
  await agent.post("/v1/ingest").set("Authorization", `Bearer ${raw}`).send({
    events: [{ requestId: "filter-me", model: "gpt-4o-mini" }],
  });

  const all = await RequestRecord.countDocuments(analytics.buildMatch({}));
  assert.ok(all >= 1, "ingested traffic must be visible without an explicit opt-in, unlike internalKind");

  const ingestedOnly = await RequestRecord.countDocuments(analytics.buildMatch({ source: "ingested" }));
  assert.equal(ingestedOnly, 1);

  const gatewayOnly = await RequestRecord.countDocuments(analytics.buildMatch({ source: "gateway" }));
  assert.equal(gatewayOnly, 0);
});
