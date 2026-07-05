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
const EvalCampaign = require("../../src/models/EvalCampaign");
const apiRoutes = require("../../src/api/routes");

let mongod, agent;
const buildApp = () => { const a = express(); a.use(express.json()); a.use("/api", apiRoutes); return a; };

async function passedRunForRec(rec) {
  const ds = await EvalDataset.create({ recommendationId: rec._id, baselineModel: "gpt-4o", candidateModel: "gpt-4o-mini", status: "ready", riskTier: "low" });
  const run = await EvalRun.create({ recommendationId: rec._id, datasetId: ds._id, status: "passed", candidateModel: "gpt-4o-mini", baselineModel: "gpt-4o" });
  rec.evalRunId = run._id; rec.evalStatus = "passed"; await rec.save();
  return run;
}
const makeRec = () => Recommendation.create({
  title: "t", reason: "r", taskType: "classification", currentModel: "gpt-4o",
  suggestedModel: "gpt-4o-mini", suggestedProvider: "openai", dedupeKey: `k-${Math.random()}`,
});

before(async () => { mongod = await MongoMemoryServer.create(); await mongoose.connect(mongod.getUri()); agent = supertest(buildApp()); });
after(async () => { await mongoose.disconnect(); await mongod.stop(); });
beforeEach(async () => { await Promise.all([Recommendation.deleteMany({}), EvalRun.deleteMany({}), EvalDataset.deleteMany({}), EvalCampaign.deleteMany({})]); });

test("campaign create is forced PAUSED without a passed offline run", async () => {
  const res = await agent.post("/api/eval/campaigns").send({ application: "support-chat", candidateModel: "gpt-4o-mini" });
  assert.equal(res.status, 201);
  assert.equal(res.body.status, "paused");
  assert.ok(/passed offline eval/.test(res.body.statusReason));
});

test("campaign create goes ACTIVE with a passed requiredEvalRunId", async () => {
  const rec = await makeRec();
  const run = await passedRunForRec(rec);
  const res = await agent.post("/api/eval/campaigns")
    .send({ application: "support-chat", candidateModel: "gpt-4o-mini", requiredEvalRunId: String(run._id) });
  assert.equal(res.status, 201);
  assert.equal(res.body.status, "active");
});

test("start-shadow is blocked without a passed eval, allowed with one", async () => {
  const rec = await makeRec();
  const blocked = await agent.post(`/api/recommendations/${rec._id}/start-shadow`).send({ application: "support-chat" });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error, "eval_required");

  await passedRunForRec(rec);
  const ok = await agent.post(`/api/recommendations/${rec._id}/start-shadow`).send({ application: "support-chat" });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.status, "active");
  assert.equal(ok.body.baselineModel, "gpt-4o");
  assert.equal(ok.body.scope.taskType, "classification");
  const updated = await Recommendation.findById(rec._id);
  assert.ok(updated.shadowCampaignId);
});

test("PATCH to active is gated on a passed run", async () => {
  const paused = await EvalCampaign.create({ application: "support-chat", candidateModel: "gpt-4o-mini", status: "paused" });
  const res = await agent.patch(`/api/eval/campaigns/${paused._id}`).send({ status: "active" });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, "eval_required");
});

test("start-shadow requires an application", async () => {
  const rec = await makeRec();
  await passedRunForRec(rec);
  const res = await agent.post(`/api/recommendations/${rec._id}/start-shadow`).send({});
  assert.equal(res.status, 400);
});
