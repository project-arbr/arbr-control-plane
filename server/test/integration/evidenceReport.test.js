"use strict";
// F-05 (exportable recommendation evidence report): GET /api/recommendations/:id/report.
process.env.ARBR_ADMIN_KEY = "";

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { MongoMemoryServer } = require("mongodb-memory-server");
const mongoose = require("mongoose");
const express = require("express");
const supertest = require("supertest");

const Recommendation = require("../../src/models/Recommendation");
const EvalRun = require("../../src/models/EvalRun");
const EvalDataset = require("../../src/models/EvalDataset");
const EvalCampaign = require("../../src/models/EvalCampaign");
const RoutingExperiment = require("../../src/models/RoutingExperiment");
const Rule = require("../../src/models/Rule");
const AuditLog = require("../../src/models/AuditLog");
const RequestRecord = require("../../src/models/RequestRecord");
const ModelEntry = require("../../src/models/ModelEntry");
const registry = require("../../src/pricing/registry");
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
    Recommendation.deleteMany({}), EvalRun.deleteMany({}), EvalDataset.deleteMany({}),
    EvalCampaign.deleteMany({}), RoutingExperiment.deleteMany({}), Rule.deleteMany({}),
    AuditLog.deleteMany({}), RequestRecord.deleteMany({}), ModelEntry.deleteMany({}),
  ]);
  await registry.reload();
});

test("404 for an unknown recommendation id", async () => {
  const res = await agent.get("/api/recommendations/000000000000000000000000/report");
  assert.equal(res.status, 404);
});

test("minimal rec (no links) -> sparse report with every section null, masking caveat still present", async () => {
  const rec = await makeRec();
  const res = await agent.get(`/api/recommendations/${rec._id}/report`);
  assert.equal(res.status, 200);
  assert.equal(res.body.reportVersion, 1);
  assert.equal(res.body.evaluation, null);
  assert.equal(res.body.shadow, null);
  assert.equal(res.body.rollout, null);
  assert.equal(res.body.outcome, null);
  assert.deepEqual(res.body.history, []);
  assert.ok(res.body.caveats.some((c) => c.includes("CURRENT configuration")));
});

test("full rec: dataset + run + campaign + experiment + 2 rules + audit rows -> every section populated, history in order", async () => {
  const rec = await makeRec({ application: "app-1" });

  const dataset = await EvalDataset.create({ recommendationId: rec._id, status: "ready", riskTier: "medium", piiMode: "masked" });
  const run = await EvalRun.create({
    recommendationId: rec._id, datasetId: dataset._id, status: "passed", riskTier: "medium",
    candidateModel: "gpt-4o-mini", baselineModel: "gpt-4o",
    summary: { judged: 300, worseRate: 0.01 }, failures: [],
  });
  const campaign = await EvalCampaign.create({ application: "app-1", candidateModel: "gpt-4o-mini", status: "done" });
  const experiment = await RoutingExperiment.create({
    recommendationId: rec._id, scope: { application: "app-1" }, baselineModel: "gpt-4o",
    candidateModel: "gpt-4o-mini", status: "promoted", rolloutPct: 100,
  });
  const rule = await Rule.create({
    condition: { taskType: "classification" }, target: { provider: "openai", model: "gpt-4o-mini" },
    enabled: true, sourceRecommendation: rec._id, qualityGate: "passed", note: "promoted",
  });
  rec.evalDatasetId = dataset._id; rec.evalRunId = run._id; rec.shadowCampaignId = campaign._id;
  rec.experimentId = experiment._id; rec.status = "accepted"; await rec.save();

  await AuditLog.create([
    { timestamp: new Date("2026-01-01T01:00:00Z"), action: "eval.run.start", entity: "evalRun", entityId: String(run._id), changes: { recommendationId: String(rec._id) }, actor: { email: "a@b.com" } },
    { timestamp: new Date("2026-01-01T02:00:00Z"), action: "canary.promote", entity: "routingExperiment", entityId: String(experiment._id), changes: { ruleId: String(rule._id) }, actor: { email: "a@b.com" } },
  ]);

  const res = await agent.get(`/api/recommendations/${rec._id}/report`);
  assert.equal(res.status, 200);
  assert.equal(res.body.stage, "promoted_live");
  assert.equal(res.body.evaluation.status, "passed");
  assert.equal(res.body.shadow.status, "done");
  assert.equal(res.body.rollout.status, "promoted");
  assert.equal(res.body.history.length, 2);
  assert.equal(res.body.history[0].action, "eval.run.start");
  assert.equal(res.body.history[1].action, "canary.promote");
});

test("unknown-pricing caveat fires when a model has no ModelEntry", async () => {
  const rec = await makeRec({ currentModel: "totally-unpriced-model" });
  const res = await agent.get(`/api/recommendations/${rec._id}/report`);
  assert.ok(res.body.caveats.some((c) => c.includes("Unknown pricing") && c.includes("totally-unpriced-model")));
  assert.equal(res.body.models.current.knownPricing, false);
});

test("insufficient-sample caveat fires when judged is below the risk-tier target", async () => {
  const rec = await makeRec();
  const dataset = await EvalDataset.create({ recommendationId: rec._id, status: "ready", riskTier: "high" });
  const run = await EvalRun.create({
    recommendationId: rec._id, datasetId: dataset._id, status: "failed", riskTier: "high",
    summary: { judged: 10 }, failures: ["only 10 items judged, need 500"],
  });
  rec.evalDatasetId = dataset._id; rec.evalRunId = run._id; await rec.save();

  const res = await agent.get(`/api/recommendations/${rec._id}/report`);
  assert.equal(res.body.evaluation.sufficientSample, false);
  assert.ok(res.body.caveats.some((c) => c.includes("Insufficient eval sample")));
});

test("auto-rollback caveat: rolled_back status with no matching canary.rollback audit row", async () => {
  const rec = await makeRec();
  const experiment = await RoutingExperiment.create({
    scope: { application: "app-1" }, baselineModel: "gpt-4o", candidateModel: "gpt-4o-mini",
    status: "rolled_back", rollbackReason: "error rate spike", lastMonitoredAt: new Date(),
  });
  rec.experimentId = experiment._id; await rec.save();
  // Deliberately NO AuditLog.create call — simulates canaryMonitor.js's un-audited auto-rollback.

  const res = await agent.get(`/api/recommendations/${rec._id}/report`);
  assert.equal(res.body.rollout.status, "rolled_back");
  assert.ok(res.body.caveats.some((c) => c.includes("no matching audit-log entry")));
});

test("a manually-audited rollback does NOT trigger the unaudited-rollback caveat", async () => {
  const rec = await makeRec();
  const experiment = await RoutingExperiment.create({
    scope: { application: "app-1" }, baselineModel: "gpt-4o", candidateModel: "gpt-4o-mini",
    status: "rolled_back", rollbackReason: "manual call",
  });
  rec.experimentId = experiment._id; await rec.save();
  await AuditLog.create({ action: "canary.rollback", entity: "routingExperiment", entityId: String(experiment._id), changes: { reason: "manual call" }, actor: { email: "a@b.com" } });

  const res = await agent.get(`/api/recommendations/${rec._id}/report`);
  assert.ok(!res.body.caveats.some((c) => c.includes("no matching audit-log entry")));
});

test("?format=markdown returns text/markdown with a download disposition", async () => {
  const rec = await makeRec();
  const res = await agent.get(`/api/recommendations/${rec._id}/report?format=markdown`);
  assert.equal(res.status, 200);
  assert.match(res.headers["content-type"], /text\/markdown/);
  assert.match(res.headers["content-disposition"], /attachment/);
  assert.match(res.text, /# Evidence report/);
});

test("outcome section populates and NO prompt/response text appears anywhere, including with payload capture off", async () => {
  await ModelEntry.create({ id: "gpt-4o", provider: "openai", inputPer1M: 5, outputPer1M: 15, tier: "premium" });
  await registry.reload();

  const rec = await makeRec({ application: "app-3" });
  await Rule.create({
    condition: { taskType: "classification" }, target: { provider: "openai", model: "gpt-4o-mini" },
    enabled: true, sourceRecommendation: rec._id, qualityGate: "passed", note: "live",
  });
  await RequestRecord.create({
    requestId: "r3", application: "app-3", taskType: "classification", status: "success",
    modelRequested: "gpt-4o", model: "gpt-4o-mini", promptTokens: 1_000_000, completionTokens: 1_000_000,
    totalCost: 1, latencyMs: 200, timestamp: new Date(),
    messages: null, responseText: null, // payload capture off
  });

  const res = await agent.get(`/api/recommendations/${rec._id}/report`);
  assert.equal(res.body.outcome.live, true);
  assert.equal(res.body.outcome.realised.savings, 19);

  const raw = JSON.stringify(res.body);
  assert.ok(!raw.includes('"messages"'));
  assert.ok(!raw.includes('"responseText"'));
});
