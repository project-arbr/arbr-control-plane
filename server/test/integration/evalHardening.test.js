"use strict";
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { MongoMemoryServer } = require("mongodb-memory-server");
const mongoose = require("mongoose");
const express = require("express");
const supertest = require("supertest");

process.env.ARBR_ADMIN_KEY = "";

const Recommendation = require("../../src/models/Recommendation");
const Rule = require("../../src/models/Rule");
const EvalDataset = require("../../src/models/EvalDataset");
const EvalItem = require("../../src/models/EvalItem");
const EvalRun = require("../../src/models/EvalRun");
const replay = require("../../src/eval/replay");
const apiRoutes = require("../../src/api/routes");

let mongod, agent;
const buildApp = () => { const a = express(); a.use(express.json()); a.use("/api", apiRoutes); return a; };
const passedRec = () => Recommendation.create({
  title: "t", reason: "r", taskType: "classification", currentModel: "gpt-4o",
  suggestedModel: "gpt-4o-mini", suggestedProvider: "openai", evalStatus: "passed", dedupeKey: `k-${Math.random()}`,
});

before(async () => { mongod = await MongoMemoryServer.create(); await mongoose.connect(mongod.getUri()); agent = supertest(buildApp()); });
after(async () => { await mongoose.disconnect(); await mongod.stop(); });
beforeEach(async () => { await Promise.all([Recommendation.deleteMany({}), Rule.deleteMany({}), EvalDataset.deleteMany({}), EvalItem.deleteMany({}), EvalRun.deleteMany({})]); });

test("#5 accept scopes the rule to the given application (not silently global)", async () => {
  const rec = await passedRec();
  const res = await agent.post(`/api/recommendations/${rec._id}/accept`).send({ scope: { application: "support-chat" } });
  assert.equal(res.status, 200);
  assert.equal(res.body.rule.condition.application, "support-chat");
  assert.equal(res.body.rule.condition.taskType, "classification");
});

test("#5 accept defaults to task-wide when no scope is given", async () => {
  const rec = await passedRec();
  const res = await agent.post(`/api/recommendations/${rec._id}/accept`).send({});
  assert.equal(res.status, 200);
  assert.equal(res.body.rule.condition.application, null);
});

test("#1 a queued run can be cancelled via the API", async () => {
  const run = await EvalRun.create({ datasetId: new mongoose.Types.ObjectId(), status: "queued" });
  const res = await agent.post(`/api/evals/runs/${run._id}/cancel`).send({});
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "cancelled");
  // cancelling again is a no-op conflict
  const again = await agent.post(`/api/evals/runs/${run._id}/cancel`).send({});
  assert.equal(again.status, 409);
});

test("#1 executeRun atomically claims a queued run and finishes gracefully with no provider", async () => {
  const rec = await passedRec();
  const ds = await EvalDataset.create({ recommendationId: rec._id, baselineModel: "gpt-4o", candidateModel: "gpt-4o-mini", status: "ready", riskTier: "low", piiMode: "masked" });
  await EvalItem.create({ datasetId: ds._id, messages: [{ role: "user", content: "hi" }], productionResponse: "ok" });
  const run = await EvalRun.create({ recommendationId: rec._id, datasetId: ds._id, baselineModel: "gpt-4o", candidateModel: "gpt-4o-mini", riskTier: "low", status: "queued", fidelity: "masked" });

  await replay.executeRun(run._id); // no provider configured in test → graceful fail, not a throw
  const after = await EvalRun.findById(run._id).lean();
  assert.equal(after.status, "failed");
  assert.match(after.error, /no live provider/);
  assert.equal(after.fidelity, "masked"); // #3 fidelity persisted
});
