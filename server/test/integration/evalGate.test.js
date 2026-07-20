"use strict";
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { MongoMemoryServer } = require("mongodb-memory-server");
const mongoose = require("mongoose");
const express = require("express");
const supertest = require("supertest");

process.env.ARBR_ADMIN_KEY = "";

const RequestRecord = require("../../src/models/RequestRecord");
const Recommendation = require("../../src/models/Recommendation");
const Rule = require("../../src/models/Rule");
const EvalDataset = require("../../src/models/EvalDataset");
const EvalItem = require("../../src/models/EvalItem");
const apiRoutes = require("../../src/api/routes");

let mongod, agent;

// Tests mount apiRoutes directly (bypassing adminAuth.middleware), so req.user
// must be stubbed the same way adminAuth would set it in adminkey/master-key mode.
const stubAdmin = (req, _res, next) => { req.user = { id: "test", email: "test-admin@test", role: "administrator" }; next(); };
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(stubAdmin);
  app.use("/api", apiRoutes);
  return app;
}

async function seedTraffic(n) {
  const docs = [];
  for (let i = 0; i < n; i++) {
    docs.push({
      requestId: `req-${i}`, timestamp: new Date(), application: "support-chat",
      provider: "openai", model: "gpt-4o", modelRequested: "gpt-4o", taskType: "classification",
      status: "success", totalCost: 0.02, latencyMs: 120, cacheHit: false,
      messages: [{ role: "user", content: `classify ticket number ${i}` }],
      responseText: "billing",
    });
  }
  await RequestRecord.insertMany(docs);
}

async function makeRec() {
  return Recommendation.create({
    type: "premium_model_overuse", title: "cheaper classification", reason: "test",
    taskType: "classification", currentModel: "gpt-4o", currentProvider: "openai",
    suggestedModel: "gpt-4o-mini", suggestedProvider: "openai",
    requestCount: 30, currentCost: 1, projectedCost: 0.2, projectedSavings: 0.8,
    dedupeKey: `k-${Math.random()}`,
  });
}

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  agent = supertest(buildApp());
});
after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});
beforeEach(async () => {
  await Promise.all([
    RequestRecord.deleteMany({}), Recommendation.deleteMany({}), Rule.deleteMany({}),
    EvalDataset.deleteMany({}), EvalItem.deleteMany({}),
  ]);
});

test("create-eval-dataset builds a ready dataset from traffic (AC2)", async () => {
  await seedTraffic(30);
  const rec = await makeRec();
  const res = await agent.post(`/api/recommendations/${rec._id}/create-eval-dataset`).send({});
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "ready");
  assert.equal(res.body.itemCount, 30);
  assert.equal(res.body.riskTier, "low"); // classification is a light task
  assert.equal(await EvalItem.countDocuments({ datasetId: res.body._id }), 30);

  const updated = await Recommendation.findById(rec._id);
  assert.equal(updated.evalStatus, "dataset_ready");
});

test("accept is BLOCKED without a passed eval (AC1)", async () => {
  const rec = await makeRec();
  const res = await agent.post(`/api/recommendations/${rec._id}/accept`).send({});
  assert.equal(res.status, 409);
  assert.equal(res.body.error, "eval_required");
  assert.equal(await Rule.countDocuments({}), 0);
});

test("accept SUCCEEDS with a valid override, and is audited via the rule", async () => {
  const rec = await makeRec();
  const res = await agent.post(`/api/recommendations/${rec._id}/accept`)
    .send({ override: { reason: "hotfix", approver: "prasanna" } });
  assert.equal(res.status, 200);
  assert.equal(res.body.acceptedVia, "overridden");
  assert.equal(res.body.rule.enabled, false); // still disabled until a human flips it on
  assert.equal(await Rule.countDocuments({}), 1);
  const updated = await Recommendation.findById(rec._id);
  assert.equal(updated.status, "accepted");
  assert.equal(updated.evalStatus, "overridden");
});

test("accept SUCCEEDS once evalStatus is passed", async () => {
  const rec = await makeRec();
  rec.evalStatus = "passed";
  await rec.save();
  const res = await agent.post(`/api/recommendations/${rec._id}/accept`).send({});
  assert.equal(res.status, 200);
  assert.equal(res.body.acceptedVia, "passed");
  assert.equal(await Rule.countDocuments({}), 1);
});

test("run-eval is rejected when no ready dataset exists", async () => {
  const rec = await makeRec();
  const res = await agent.post(`/api/recommendations/${rec._id}/run-eval`).send({});
  assert.equal(res.status, 409);
  assert.equal(res.body.error, "no_dataset");
});
