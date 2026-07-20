"use strict";
// Arbr's own internal spend must be counted in headline cost but never attributed to a
// customer application. These are regression tests for a real bug: before internalKind
// existed, the AI classifier logged itself as application "arbr-internal", which nothing
// filtered — so it appeared as a fake app, fed recommendations, and counted against
// customer budget caps.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { MongoMemoryServer } = require("mongodb-memory-server");
const mongoose = require("mongoose");
const express = require("express");
const supertest = require("supertest");

process.env.ARBR_ADMIN_KEY = "";

const RequestRecord = require("../../src/models/RequestRecord");
const Cap = require("../../src/models/Cap");
const Recommendation = require("../../src/models/Recommendation");
const apiRoutes = require("../../src/api/routes");
const analytics = require("../../src/analytics/aggregate");
const engine = require("../../src/recommend/engine");
const { backfillInternalKind } = require("../../src/maintenance/backfillInternalKind");

let mongod;
let agent;

const stubAdmin = (req, _res, next) => { req.user = { id: "test", email: "t@t", role: "administrator" }; next(); };
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(stubAdmin);
  app.use("/api", apiRoutes);
  return app;
}

let seq = 0;
function rec(over = {}) {
  seq += 1;
  return {
    requestId: `r-${seq}`,
    timestamp: new Date(),
    application: "checkout", workflow: "wf", department: "eng", userId: "u1",
    provider: "openai", model: "gpt-4o-mini", modelRequested: "gpt-4o-mini",
    taskType: "summarization",
    promptTokens: 100, completionTokens: 50, totalTokens: 150,
    totalCost: 1, latencyMs: 100, status: "success", knownPricing: true,
    ...over,
  };
}
// An internal record as the wrapper will write it: no customer dimensions at all.
function internalRec(over = {}) {
  return rec({
    application: null, workflow: null, department: null, userId: null, taskType: null,
    internalKind: "classifier", totalCost: 0.25, latencyMs: 9999,
    ...over,
  });
}

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  agent = supertest(buildApp());
});
after(async () => { await mongoose.disconnect(); await mongod.stop(); });
beforeEach(async () => {
  await Promise.all([RequestRecord.deleteMany({}), Cap.deleteMany({}), Recommendation.deleteMany({})]);
});

test("internal spend is in the headline total but split out", async () => {
  await RequestRecord.create([rec(), rec(), internalRec()]);
  const { body } = await agent.get("/api/analytics/overview").expect(200);

  assert.equal(body.totalCost, 2.25, "headline total includes overhead — it is real money");
  assert.equal(body.customerCost, 2);
  assert.equal(body.internalCost, 0.25);
  assert.equal(body.internalRequests, 1);
  assert.ok(Math.abs(body.internalShare - 0.25 / 2.25) < 1e-9);
  assert.equal(body.totalCost, body.customerCost + body.internalCost, "the split must reconcile");

  // Customer-only metrics must not be distorted by the internal record's 9999ms latency.
  assert.equal(body.totalRequests, 2, "request count is customer-only");
  assert.equal(body.avgLatency, 100, "avgLatency must ignore internal calls");
});

test("a dimension-scoped overview reports zero overhead", async () => {
  await RequestRecord.create([rec(), internalRec()]);
  const { body } = await agent.get("/api/analytics/overview?application=checkout").expect(200);
  assert.equal(body.internalCost, 0);
  assert.equal(body.internalShare, 0);
  assert.equal(body.totalCost, 1, "scoped views see customer traffic only");
});

test("internal records never appear as an application", async () => {
  await RequestRecord.create([rec(), internalRec()]);

  const byApp = (await agent.get("/api/analytics/by/application").expect(200)).body;
  assert.deepEqual(byApp.map((r) => r.key), ["checkout"]);

  const facets = (await agent.get("/api/analytics/facets").expect(200)).body;
  assert.ok(!facets.applications.includes("arbr-internal"), "the legacy sentinel must be gone");
  assert.deepEqual(facets.applications, ["checkout"]);
  assert.ok(!facets.taskTypes.includes(null));
});

test("the request list hides internal records unless asked", async () => {
  await RequestRecord.create([rec(), internalRec()]);

  const dflt = (await agent.get("/api/requests").expect(200)).body;
  assert.equal(dflt.items.length, 1);
  assert.equal(dflt.items[0].application, "checkout");

  const internal = (await agent.get("/api/requests?internalScope=internal").expect(200)).body;
  assert.equal(internal.items.length, 1);
  assert.equal(internal.items[0].internalKind, "classifier");
});

test("internal-spend endpoint breaks overhead down by kind and model", async () => {
  await RequestRecord.create([
    rec(),
    internalRec({ internalKind: "classifier", totalCost: 0.25 }),
    internalRec({ internalKind: "policy-generation", totalCost: 2, model: "gpt-4o" }),
  ]);
  const { body } = await agent.get("/api/analytics/internal-spend").expect(200);

  assert.equal(body.totalCost, 2.25);
  assert.equal(body.totalRequests, 2);
  const kinds = Object.fromEntries(body.byKind.map((r) => [r.key, r.cost]));
  assert.deepEqual(kinds, { "policy-generation": 2, classifier: 0.25 });
  // byModel is what surfaces an expensive surprise, e.g. policy generation on a premium model.
  assert.ok(body.byModel.some((r) => r.key === "gpt-4o" && r.cost === 2));
});

// The highest-value test here: this is the path that can 429 real customer traffic.
test("global caps count internal spend; scoped caps do not", async () => {
  const from = new Date(Date.now() - 60_000);
  await RequestRecord.create([rec(), internalRec()]);

  const global = await analytics.spend({ from, includeInternal: true });
  assert.equal(global, 1.25, "a global cap sees Arbr's overhead — it is real spend");

  const scoped = await analytics.spend({ dimension: "application", value: "checkout", from });
  assert.equal(scoped, 1, "an application cap must not see overhead");

  const providerScoped = await analytics.spend({ dimension: "provider", value: "openai", from });
  assert.equal(providerScoped, 1, "a provider cap must not see overhead either");

  // Default is customer-only, so a caller that forgets the flag can't over-count.
  assert.equal(await analytics.spend({ from }), 1);
});

test("recommendations ignore internal traffic", async () => {
  // Enough volume to clear the engine's minimum-requests threshold.
  const many = [];
  for (let i = 0; i < 60; i++) {
    many.push(internalRec({ internalKind: "classifier", model: "gpt-4o", totalCost: 5, promptTokens: 5000, completionTokens: 2000 }));
  }
  await RequestRecord.create(many);
  await engine.recompute();

  const recs = await Recommendation.find().lean();
  assert.ok(
    !recs.some((r) => String(r.dedupeKey).includes("arbr-internal") || r.application === null),
    "no recommendation should be generated from Arbr's own spend"
  );
});

test("records written before internalKind existed count as customer traffic", async () => {
  // Insert through the driver so the schema default can't backfill the field —
  // this is what a genuinely old document looks like.
  await mongoose.connection.collection("request_records").insertOne({
    requestId: "legacy-1", timestamp: new Date(),
    application: "legacy-app", provider: "openai", model: "gpt-4o-mini",
    totalCost: 3, latencyMs: 10, status: "success", knownPricing: true,
    promptTokens: 1, completionTokens: 1, totalTokens: 2,
  });
  const { body } = await agent.get("/api/analytics/overview").expect(200);
  assert.equal(body.customerCost, 3, "a missing internalKind must read as customer traffic");
  assert.equal(body.internalCost, 0);
});

test("backfill relabels legacy arbr-internal records and is idempotent", async () => {
  await mongoose.connection.collection("request_records").insertOne({
    requestId: "legacy-internal-1", timestamp: new Date(),
    application: "arbr-internal", workflow: "auto-classifier", department: "arbr",
    taskType: "classification", provider: "openai", model: "gpt-4o-mini",
    totalCost: 0.5, latencyMs: 10, status: "success", knownPricing: true,
    promptTokens: 1, completionTokens: 1, totalTokens: 2,
  });

  const first = await backfillInternalKind();
  assert.equal(first.modifiedCount, 1);

  const doc = await RequestRecord.findOne({ requestId: "legacy-internal-1" }).lean();
  assert.equal(doc.internalKind, "classifier");
  assert.equal(doc.application, null, "the fake application must be cleared");
  assert.equal(doc.taskType, null, "the fake task type must be cleared");
  assert.equal(doc.internalContext.migratedFrom, "arbr-internal");

  // Second run must be a no-op.
  const second = await backfillInternalKind();
  assert.equal(second.modifiedCount, 0);

  const facets = (await agent.get("/api/analytics/facets").expect(200)).body;
  assert.ok(!facets.applications.includes("arbr-internal"));
});
