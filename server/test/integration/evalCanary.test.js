"use strict";
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { MongoMemoryServer } = require("mongodb-memory-server");
const mongoose = require("mongoose");
const express = require("express");
const supertest = require("supertest");

process.env.ARBR_ADMIN_KEY = "";

const Recommendation = require("../../src/models/Recommendation");
const EvalRun = require("../../src/models/EvalRun");
const EvalDataset = require("../../src/models/EvalDataset");
const RoutingExperiment = require("../../src/models/RoutingExperiment");
const Rule = require("../../src/models/Rule");
const apiRoutes = require("../../src/api/routes");

let mongod, agent;
// Tests mount apiRoutes directly (bypassing adminAuth.middleware), so req.user
// must be stubbed the same way adminAuth would set it in adminkey/master-key mode.
const stubAdmin = (req, _res, next) => { req.user = { id: "test", email: "test-admin@test", role: "administrator" }; next(); };
const buildApp = () => { const a = express(); a.use(express.json()); a.use(stubAdmin); a.use("/api", apiRoutes); return a; };

const makeRec = () => Recommendation.create({
  title: "t", reason: "r", taskType: "classification", currentModel: "gpt-4o",
  suggestedModel: "gpt-4o-mini", suggestedProvider: "openai", dedupeKey: `k-${Math.random()}`,
});
async function pass(rec) {
  const ds = await EvalDataset.create({ recommendationId: rec._id, status: "ready", riskTier: "low" });
  const run = await EvalRun.create({ recommendationId: rec._id, datasetId: ds._id, status: "passed", candidateModel: "gpt-4o-mini", baselineModel: "gpt-4o" });
  rec.evalRunId = run._id; rec.evalStatus = "passed"; await rec.save();
}

before(async () => { mongod = await MongoMemoryServer.create(); await mongoose.connect(mongod.getUri()); agent = supertest(buildApp()); });
after(async () => { await mongoose.disconnect(); await mongod.stop(); });
beforeEach(async () => { await Promise.all([Recommendation.deleteMany({}), EvalRun.deleteMany({}), EvalDataset.deleteMany({}), RoutingExperiment.deleteMany({}), Rule.deleteMany({})]); });

test("create-canary is blocked without a passed eval", async () => {
  const rec = await makeRec();
  const res = await agent.post(`/api/recommendations/${rec._id}/create-canary`).send({ application: "support-chat" });
  assert.equal(res.status, 409);
});

test("create-canary makes an active experiment scoped to the rec", async () => {
  const rec = await makeRec();
  await pass(rec);
  const res = await agent.post(`/api/recommendations/${rec._id}/create-canary`).send({ application: "support-chat", rolloutPct: 15 });
  assert.equal(res.status, 201);
  assert.equal(res.body.status, "active");
  assert.equal(res.body.rolloutPct, 15);
  assert.equal(res.body.baselineModel, "gpt-4o");
  assert.equal(res.body.candidateModel, "gpt-4o-mini");
  assert.equal(res.body.scope.taskType, "classification");
  const updated = await Recommendation.findById(rec._id);
  assert.ok(updated.experimentId);
});

test("rollback sets status rolled_back with a reason", async () => {
  const exp = await RoutingExperiment.create({ baselineModel: "gpt-4o", candidateModel: "gpt-4o-mini", status: "active" });
  const res = await agent.post(`/api/routing-experiments/${exp._id}/rollback`).send({ reason: "spike" });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "rolled_back");
  assert.equal(res.body.rollbackReason, "spike");
});

test("promote creates an enabled rule and marks the rec accepted", async () => {
  const rec = await makeRec();
  const exp = await RoutingExperiment.create({
    recommendationId: rec._id, baselineModel: "gpt-4o", candidateModel: "gpt-4o-mini", candidateProvider: "openai",
    scope: { taskType: "classification", application: "support-chat" }, status: "active",
  });
  const res = await agent.post(`/api/routing-experiments/${exp._id}/promote`).send({ approvedBy: "prasanna" });
  assert.equal(res.status, 200);
  assert.equal(res.body.experiment.status, "promoted");
  assert.equal(res.body.experiment.rolloutPct, 100);
  assert.equal(res.body.rule.enabled, true);
  assert.equal(res.body.rule.target.provider, "openai"); // provider comes from candidateProvider, not the registry
  assert.equal(res.body.rule.target.model, "gpt-4o-mini");
  const updatedRec = await Recommendation.findById(rec._id);
  assert.equal(updatedRec.status, "accepted");
});

test("cannot promote a rolled-back experiment", async () => {
  const exp = await RoutingExperiment.create({ baselineModel: "gpt-4o", candidateModel: "gpt-4o-mini", status: "rolled_back" });
  const res = await agent.post(`/api/routing-experiments/${exp._id}/promote`).send({});
  assert.equal(res.status, 409);
});
