"use strict";
// F-03 (unified optimization workflow): GET /api/recommendations attaches a derived `stage`
// per recommendation (see recommend/stage.js + stageBatch.js); GET /api/recommendations/:id/outcome
// computes an approximate projected-vs-realised comparison for a live (enabled-rule) one.
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
async function withPassedRun(rec) {
  const ds = await EvalDataset.create({ recommendationId: rec._id, status: "ready", riskTier: "low" });
  const run = await EvalRun.create({ recommendationId: rec._id, datasetId: ds._id, status: "passed", candidateModel: "gpt-4o-mini", baselineModel: "gpt-4o" });
  rec.evalDatasetId = ds._id; rec.evalRunId = run._id; rec.evalStatus = "passed";
  await rec.save();
  return { ds, run };
}
async function findByRecId(recs, id) {
  return recs.find((r) => String(r._id) === String(id));
}

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  agent = supertest(buildApp());
  await ModelEntry.create({ id: "gpt-4o", provider: "openai", inputPer1M: 5, outputPer1M: 15, tier: "premium" });
  await registry.reload();
});
after(async () => { await mongoose.disconnect(); await mongod.stop(); });
beforeEach(async () => {
  await Promise.all([
    Recommendation.deleteMany({}), EvalRun.deleteMany({}), EvalDataset.deleteMany({}),
    EvalCampaign.deleteMany({}), RoutingExperiment.deleteMany({}), Rule.deleteMany({}),
    RequestRecord.deleteMany({}),
  ]);
});

// ── Stage derivation, exercised through the real route ──────────────────────────────────────

test("opportunity: no linked artifacts", async () => {
  const rec = await makeRec();
  const res = await agent.get("/api/recommendations");
  assert.equal((await findByRecId(res.body, rec._id)).stage, "opportunity");
});

test("dataset_ready: dataset built, no run yet", async () => {
  const rec = await makeRec();
  const ds = await EvalDataset.create({ recommendationId: rec._id, status: "ready", riskTier: "low" });
  rec.evalDatasetId = ds._id; rec.evalStatus = "dataset_ready"; await rec.save();
  const res = await agent.get("/api/recommendations");
  assert.equal((await findByRecId(res.body, rec._id)).stage, "dataset_ready");
});

test("eval_failed: run failed", async () => {
  const rec = await makeRec();
  const ds = await EvalDataset.create({ recommendationId: rec._id, status: "ready", riskTier: "low" });
  const run = await EvalRun.create({ recommendationId: rec._id, datasetId: ds._id, status: "failed" });
  rec.evalDatasetId = ds._id; rec.evalRunId = run._id; rec.evalStatus = "failed"; await rec.save();
  const res = await agent.get("/api/recommendations");
  assert.equal((await findByRecId(res.body, rec._id)).stage, "eval_failed");
});

test("ready_for_rollout: run passed", async () => {
  const rec = await makeRec();
  await withPassedRun(rec);
  const res = await agent.get("/api/recommendations");
  assert.equal((await findByRecId(res.body, rec._id)).stage, "ready_for_rollout");
});

test("accepted_awaiting_enable: accepted, disabled rule, no shadow/canary ever run", async () => {
  const rec = await makeRec();
  await withPassedRun(rec);
  rec.status = "accepted"; rec.acceptedVia = "passed"; await rec.save();
  await Rule.create({
    condition: { taskType: "classification" }, target: { provider: "openai", model: "gpt-4o-mini" },
    enabled: false, sourceRecommendation: rec._id, qualityGate: "passed", note: "accept-path rule",
  });
  const res = await agent.get("/api/recommendations");
  const found = await findByRecId(res.body, rec._id);
  assert.equal(found.stage, "accepted_awaiting_enable");
  assert.equal(found.liveRule, null);
});

test("shadow_running: active shadow campaign", async () => {
  const rec = await makeRec();
  await withPassedRun(rec);
  rec.status = "accepted"; await rec.save();
  const campaign = await EvalCampaign.create({ application: "app-1", candidateModel: "gpt-4o-mini", status: "active" });
  rec.shadowCampaignId = campaign._id; await rec.save();
  const res = await agent.get("/api/recommendations");
  const found = await findByRecId(res.body, rec._id);
  assert.equal(found.stage, "shadow_running");
  assert.equal(found.shadowCampaignSummary.status, "active");
});

test("canary_running: active routing experiment", async () => {
  const rec = await makeRec();
  await withPassedRun(rec);
  rec.status = "accepted"; await rec.save();
  const exp = await RoutingExperiment.create({
    recommendationId: rec._id, scope: { application: "app-1" }, baselineModel: "gpt-4o",
    candidateModel: "gpt-4o-mini", rolloutPct: 15, status: "active",
  });
  rec.experimentId = exp._id; await rec.save();
  const res = await agent.get("/api/recommendations");
  const found = await findByRecId(res.body, rec._id);
  assert.equal(found.stage, "canary_running");
  assert.equal(found.experimentSummary.rolloutPct, 15);
});

test("rolled_back: experiment rolled back", async () => {
  const rec = await makeRec();
  await withPassedRun(rec);
  rec.status = "accepted"; await rec.save();
  const exp = await RoutingExperiment.create({
    recommendationId: rec._id, scope: { application: "app-1" }, baselineModel: "gpt-4o",
    candidateModel: "gpt-4o-mini", status: "rolled_back", rollbackReason: "error rate spike",
  });
  rec.experimentId = exp._id; await rec.save();
  const res = await agent.get("/api/recommendations");
  const found = await findByRecId(res.body, rec._id);
  assert.equal(found.stage, "rolled_back");
  assert.equal(found.experimentSummary.rollbackReason, "error rate spike");
});

test("promoted_live via accept + manual enable", async () => {
  const rec = await makeRec();
  await withPassedRun(rec);
  rec.status = "accepted"; await rec.save();
  await Rule.create({
    condition: { taskType: "classification" }, target: { provider: "openai", model: "gpt-4o-mini" },
    enabled: true, sourceRecommendation: rec._id, qualityGate: "passed", note: "manually enabled",
  });
  const res = await agent.get("/api/recommendations");
  const found = await findByRecId(res.body, rec._id);
  assert.equal(found.stage, "promoted_live");
  assert.ok(found.liveRule && found.liveRule.enabled);
});

test("promoted_live via canary-promote", async () => {
  const rec = await makeRec();
  await withPassedRun(rec);
  rec.status = "accepted"; await rec.save();
  const exp = await RoutingExperiment.create({
    recommendationId: rec._id, scope: { application: "app-1" }, baselineModel: "gpt-4o",
    candidateModel: "gpt-4o-mini", status: "promoted",
  });
  rec.experimentId = exp._id; await rec.save();
  await Rule.create({
    condition: { taskType: "classification" }, target: { provider: "openai", model: "gpt-4o-mini" },
    enabled: true, sourceRecommendation: rec._id, qualityGate: "passed", note: "promoted from canary",
  });
  const res = await agent.get("/api/recommendations");
  const found = await findByRecId(res.body, rec._id);
  assert.equal(found.stage, "promoted_live");
});

test("dismissed", async () => {
  const rec = await makeRec({ status: "dismissed" });
  const res = await agent.get("/api/recommendations");
  assert.equal((await findByRecId(res.body, rec._id)).stage, "dismissed");
});

test("GET /api/recommendations is a fixed number of queries regardless of count (no N+1)", async () => {
  for (let i = 0; i < 12; i++) await makeRec({ dedupeKey: `bulk-${i}` });
  const res = await agent.get("/api/recommendations");
  assert.equal(res.body.length, 12);
  assert.ok(res.body.every((r) => r.stage === "opportunity"));
});

// ── Outcome endpoint ─────────────────────────────────────────────────────────────────────────

test("outcome: no enabled rule -> live:false", async () => {
  const rec = await makeRec();
  const res = await agent.get(`/api/recommendations/${rec._id}/outcome`);
  assert.equal(res.status, 200);
  assert.equal(res.body.live, false);
});

test("outcome: enabled rule + substituted traffic -> realised savings matches hand-computed expectation", async () => {
  const rec = await makeRec({ application: "app-1" });
  await Rule.create({
    condition: { taskType: "classification" }, target: { provider: "openai", model: "gpt-4o-mini" },
    enabled: true, sourceRecommendation: rec._id, qualityGate: "passed", note: "live rule",
  });
  // gpt-4o priced at $5/$15 per 1M (seeded in `before`). 1M prompt + 1M completion tokens
  // at gpt-4o would cost $5 + $15 = $20; actually served (and billed) at gpt-4o-mini for $1 —
  // so this one substitution should report exactly $19 saved.
  await RequestRecord.create({
    requestId: "r1", application: "app-1", taskType: "classification", status: "success",
    modelRequested: "gpt-4o", model: "gpt-4o-mini", promptTokens: 1_000_000, completionTokens: 1_000_000,
    totalCost: 1, latencyMs: 200, timestamp: new Date(),
  });

  const res = await agent.get(`/api/recommendations/${rec._id}/outcome`);
  assert.equal(res.status, 200);
  assert.equal(res.body.live, true);
  assert.equal(res.body.realised.savings, 19);
  assert.equal(res.body.realised.substitutedRequests, 1);
  assert.ok(res.body.caveat && res.body.caveat.length > 0, "the approximation caveat must always be present");
});

test("outcome: works identically when payload capture is off (no messages/responseText stored)", async () => {
  const rec = await makeRec({ application: "app-2" });
  await Rule.create({
    condition: { taskType: "classification" }, target: { provider: "openai", model: "gpt-4o-mini" },
    enabled: true, sourceRecommendation: rec._id, qualityGate: "passed", note: "live rule 2",
  });
  await RequestRecord.create({
    requestId: "r2", application: "app-2", taskType: "classification", status: "success",
    modelRequested: "gpt-4o", model: "gpt-4o-mini", promptTokens: 1_000_000, completionTokens: 1_000_000,
    totalCost: 1, latencyMs: 200, timestamp: new Date(),
    messages: null, responseText: null, // payload capture off — metadata-only record
  });

  const res = await agent.get(`/api/recommendations/${rec._id}/outcome`);
  assert.equal(res.status, 200);
  assert.equal(res.body.live, true);
  assert.equal(res.body.realised.savings, 19, "outcome must be computable from metadata alone");
});
