"use strict";
// F-07 (cloud secret-manager integration): POST /api/secrets/refresh.
process.env.ARBR_ADMIN_KEY = "";

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { MongoMemoryServer } = require("mongodb-memory-server");
const mongoose = require("mongoose");
const express = require("express");
const supertest = require("supertest");

const apiRoutes = require("../../src/api/routes");
const secretResolver = require("../../src/security/secretResolver");

let mongod, agent;
let currentTestUser = { id: "admin-1", email: "admin@test", role: "administrator" };
const stubUser = (req, _res, next) => { req.user = currentTestUser; next(); };
const buildApp = () => {
  const a = express();
  a.use(express.json());
  a.use(stubUser);
  a.use("/api", apiRoutes);
  return a;
};

const fakeProvider = {
  scheme: "fake",
  matches: (uri) => typeof uri === "string" && uri.startsWith("fake://"),
  resolve: async (uri) => {
    if (uri.includes("fail")) throw new Error("injected fake-secret failure for test XYZ-do-not-leak");
    return "injected-fake-secret-value-should-never-appear-in-response";
  },
};

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  agent = supertest(buildApp());
  secretResolver.PROVIDERS_REGISTRY.push(fakeProvider);
});
after(async () => {
  const i = secretResolver.PROVIDERS_REGISTRY.indexOf(fakeProvider);
  if (i >= 0) secretResolver.PROVIDERS_REGISTRY.splice(i, 1);
  await mongoose.disconnect();
  await mongod.stop();
});
beforeEach(() => {
  currentTestUser = { id: "admin-1", email: "admin@test", role: "administrator" };
  delete process.env.OPENAI_API_KEY;
});

test("requires administrator role — 403 for operator", async () => {
  currentTestUser = { id: "o-1", email: "operator@test", role: "operator" };
  const res = await agent.post("/api/secrets/refresh");
  assert.equal(res.status, 403);
});

test("administrator: resolves configured refs, returns counts and failures — never a value", async () => {
  process.env.OPENAI_API_KEY = "fake://openai-key";
  const res = await agent.post("/api/secrets/refresh");
  delete process.env.OPENAI_API_KEY;

  assert.equal(res.status, 200);
  assert.equal(typeof res.body.resolved, "number");
  assert.ok(res.body.resolved >= 1);
  assert.deepEqual(res.body.failures, []);

  const serialized = JSON.stringify(res.body);
  assert.ok(!serialized.includes("injected-fake-secret-value-should-never-appear-in-response"));
});

test("administrator: a failing ref is reported in failures, response still has no value or leaked detail beyond the error field", async () => {
  process.env.OPENAI_API_KEY = "fake://please-fail";
  const res = await agent.post("/api/secrets/refresh");
  delete process.env.OPENAI_API_KEY;

  assert.equal(res.status, 200);
  assert.equal(res.body.failures.length, 1);
  assert.equal(res.body.failures[0].name, "OPENAI_API_KEY");
  assert.match(res.body.failures[0].error, /injected fake-secret failure for test XYZ-do-not-leak/);
});
