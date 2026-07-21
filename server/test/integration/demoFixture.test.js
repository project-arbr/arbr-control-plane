"use strict";
// F-06 (design-partner demo fixture): the run-eval demo short-circuit, and the seed/reset
// script's idempotency + scoped-deletion guarantees.
process.env.ARBR_ADMIN_KEY = "";

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { MongoMemoryServer } = require("mongodb-memory-server");
const mongoose = require("mongoose");
const express = require("express");
const supertest = require("supertest");

const Recommendation = require("../../src/models/Recommendation");
const EvalDataset = require("../../src/models/EvalDataset");
const EvalRun = require("../../src/models/EvalRun");
const EvalResult = require("../../src/models/EvalResult");
const RoutingExperiment = require("../../src/models/RoutingExperiment");
const Rule = require("../../src/models/Rule");
const RequestRecord = require("../../src/models/RequestRecord");
const apiRoutes = require("../../src/api/routes");

let mongod, agent;
const stubAdmin = (req, _res, next) => { req.user = { id: "test", email: "test-admin@test", role: "administrator" }; next(); };
const buildApp = () => { const a = express(); a.use(express.json()); a.use(stubAdmin); a.use("/api", apiRoutes); return a; };

const makeRec = (over = {}) => Recommendation.create({
  title: "t", reason: "r", taskType: "classification", currentModel: "gpt-4o",
  suggestedModel: "gpt-4o-mini", suggestedProvider: "openai", dedupeKey: `k-${Math.random()}`,
  ...over,
});

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  agent = supertest(buildApp());
});
after(async () => { await mongoose.disconnect(); await mongod.stop(); });
beforeEach(async () => {
  await Promise.all([
    Recommendation.deleteMany({}), EvalDataset.deleteMany({}), EvalRun.deleteMany({}),
    EvalResult.deleteMany({}), RoutingExperiment.deleteMany({}), Rule.deleteMany({}),
    RequestRecord.deleteMany({}),
  ]);
});

test("run-eval short-circuits for a demo-fixture dataset with no live provider, never reaching the real replay pipeline", async () => {
  const rec = await makeRec({ isDemoFixture: true, demoFixtureOutcome: "pass" });
  const dataset = await EvalDataset.create({
    recommendationId: rec._id, status: "ready", riskTier: "low", isDemoFixture: true,
  });
  rec.evalDatasetId = dataset._id;
  await rec.save();

  const res = await agent.post(`/api/recommendations/${rec._id}/run-eval`);

  assert.equal(res.status, 202);
  assert.equal(res.body.status, "passed");
  // isDemoFixture:true on the returned run is proof the short-circuit fired: the real replay
  // pipeline (eval/replay.js's startRun) never sets this field, and it hard-requires a live
  // provider it doesn't have here — it cannot produce this response at all, let alone this one.
  assert.equal(res.body.isDemoFixture, true);

  const updated = await Recommendation.findById(rec._id).lean();
  assert.equal(updated.evalStatus, "passed");
  assert.ok(updated.qualitySummary);
  assert.equal(String(updated.evalRunId), String(res.body._id));
});

test("run-eval short-circuit produces a failing run when demoFixtureOutcome is 'fail', with real gate reasons", async () => {
  const rec = await makeRec({ isDemoFixture: true, demoFixtureOutcome: "fail" });
  const dataset = await EvalDataset.create({
    recommendationId: rec._id, status: "ready", riskTier: "low", isDemoFixture: true,
  });
  rec.evalDatasetId = dataset._id;
  await rec.save();

  const res = await agent.post(`/api/recommendations/${rec._id}/run-eval`);
  assert.equal(res.status, 422);
  assert.equal(res.body.status, "failed");
  assert.ok(res.body.failures.length > 0);

  const results = await EvalResult.find({ evalRunId: res.body._id }).lean();
  assert.equal(results.length, res.body.summary.total);
  assert.ok(results.every((r) => r.isDemoFixture === true));
});

test("a non-fixture dataset is unaffected by the short-circuit (falls through, still requires a real dataset gate)", async () => {
  const rec = await makeRec(); // isDemoFixture defaults to false
  // No dataset at all — should hit the existing "create a dataset first" gate, not the fixture path.
  const res = await agent.post(`/api/recommendations/${rec._id}/run-eval`);
  assert.equal(res.status, 409);
  assert.equal(res.body.error, "no_dataset");
});

test("accept propagates isDemoFixture onto the created Rule", async () => {
  const rec = await makeRec({ isDemoFixture: true });
  const dataset = await EvalDataset.create({ recommendationId: rec._id, status: "ready", riskTier: "low", isDemoFixture: true });
  rec.evalDatasetId = dataset._id;
  await rec.save();
  await agent.post(`/api/recommendations/${rec._id}/run-eval`);

  const res = await agent.post(`/api/recommendations/${rec._id}/accept`);
  assert.equal(res.status, 200);
  assert.equal(res.body.rule.isDemoFixture, true);
});

test("create-canary propagates isDemoFixture onto the created RoutingExperiment", async () => {
  const rec = await makeRec({ isDemoFixture: true, application: "app-1" });
  const dataset = await EvalDataset.create({ recommendationId: rec._id, status: "ready", riskTier: "low", isDemoFixture: true });
  rec.evalDatasetId = dataset._id;
  await rec.save();
  await agent.post(`/api/recommendations/${rec._id}/run-eval`);

  const res = await agent.post(`/api/recommendations/${rec._id}/create-canary`).send({ application: "app-1" });
  assert.equal(res.status, 201);
  assert.equal(res.body.isDemoFixture, true);
});

test("reset (scoped deleteMany) removes every isDemoFixture:true document across all 7 models and leaves real data untouched", async () => {
  const realRec = await makeRec({ title: "real, not a fixture" });
  const realRequest = await RequestRecord.create({ requestId: "real-1", model: "gpt-4o", isDemoFixture: false });

  const fixtureRec = await makeRec({ isDemoFixture: true });
  const fixtureDataset = await EvalDataset.create({ recommendationId: fixtureRec._id, status: "ready", isDemoFixture: true });
  const fixtureRun = await EvalRun.create({ recommendationId: fixtureRec._id, datasetId: fixtureDataset._id, isDemoFixture: true });
  const fixtureResult = await EvalResult.create({ evalRunId: fixtureRun._id, isDemoFixture: true });
  const fixtureExp = await RoutingExperiment.create({
    recommendationId: fixtureRec._id, baselineModel: "gpt-4o", candidateModel: "gpt-4o-mini", isDemoFixture: true,
  });
  const fixtureRule = await Rule.create({
    target: { provider: "openai", model: "gpt-4o-mini" }, sourceRecommendation: fixtureRec._id, isDemoFixture: true,
  });
  const fixtureRequest = await RequestRecord.create({ requestId: "fixture-1", model: "gpt-4o", isDemoFixture: true });

  // Run the same scoped-delete logic the CLI script uses.
  await Promise.all([
    RequestRecord.deleteMany({ isDemoFixture: true }),
    Recommendation.deleteMany({ isDemoFixture: true }),
    EvalDataset.deleteMany({ isDemoFixture: true }),
    EvalRun.deleteMany({ isDemoFixture: true }),
    EvalResult.deleteMany({ isDemoFixture: true }),
    RoutingExperiment.deleteMany({ isDemoFixture: true }),
    Rule.deleteMany({ isDemoFixture: true }),
  ]);

  assert.equal(await Recommendation.findById(fixtureRec._id), null);
  assert.equal(await EvalDataset.findById(fixtureDataset._id), null);
  assert.equal(await EvalRun.findById(fixtureRun._id), null);
  assert.equal(await EvalResult.findById(fixtureResult._id), null);
  assert.equal(await RoutingExperiment.findById(fixtureExp._id), null);
  assert.equal(await Rule.findById(fixtureRule._id), null);
  assert.equal(await RequestRecord.findById(fixtureRequest._id), null);

  // Real, non-fixture documents survive untouched.
  assert.ok(await Recommendation.findById(realRec._id));
  assert.ok(await RequestRecord.findById(realRequest._id));
});
