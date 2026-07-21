"use strict";
// F-08 (operational readiness): GET/POST /api/ops/{export,import,support-bundle}.
process.env.ARBR_ADMIN_KEY = "";

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { MongoMemoryServer } = require("mongodb-memory-server");
const mongoose = require("mongoose");
const express = require("express");
const supertest = require("supertest");

const apiRoutes = require("../../src/api/routes");
const Rule = require("../../src/models/Rule");
const Cap = require("../../src/models/Cap");
const ProviderCredential = require("../../src/models/ProviderCredential");
const RequestRecord = require("../../src/models/RequestRecord");
const AuditLog = require("../../src/models/AuditLog");

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

const FAKE_SECRET = "injected-fake-provider-secret-must-never-leak-XYZ123";
const FAKE_PAYLOAD = "injected-fake-captured-prompt-text-must-never-leak-XYZ456";
const FAKE_AUDIT_CHANGE = "injected-fake-audit-changes-payload-must-never-leak-XYZ789";

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
  currentTestUser = { id: "admin-1", email: "admin@test", role: "administrator" };
  await Promise.all([
    Rule.deleteMany({}), Cap.deleteMany({}), ProviderCredential.deleteMany({}),
    RequestRecord.deleteMany({}), AuditLog.deleteMany({}),
  ]);
});

test("export requires administrator role — 403 for operator", async () => {
  currentTestUser = { id: "o-1", email: "operator@test", role: "operator" };
  const res = await agent.get("/api/ops/export");
  assert.equal(res.status, 403);
});

test("import requires administrator role — 403 for operator", async () => {
  currentTestUser = { id: "o-1", email: "operator@test", role: "operator" };
  const res = await agent.post("/api/ops/import").send({ exportVersion: 1 });
  assert.equal(res.status, 403);
});

test("support-bundle requires administrator role — 403 for operator", async () => {
  currentTestUser = { id: "o-1", email: "operator@test", role: "operator" };
  const res = await agent.post("/api/ops/support-bundle");
  assert.equal(res.status, 403);
});

test("export never includes a provider credential, even though one exists", async () => {
  await ProviderCredential.create({
    provider: "openai", ciphertext: FAKE_SECRET, iv: "iv", tag: "tag", last4: "abcd",
  });
  const res = await agent.get("/api/ops/export");
  assert.equal(res.status, 200);
  assert.ok(!JSON.stringify(res.body).includes(FAKE_SECRET));
});

test("export/import round-trip: rules and caps survive, with fresh ids and isDemoFixture forced false", async () => {
  const rule = await Rule.create({
    target: { provider: "openai", model: "gpt-4o-mini" }, note: "roundtrip-test", isDemoFixture: true,
  });
  const cap = await Cap.create({ limit: 500, action: "alert" });

  const exported = await agent.get("/api/ops/export");
  assert.equal(exported.status, 200);
  assert.equal(exported.body.exportVersion, 1);
  assert.equal(exported.body.rules.length, 1);
  assert.equal(exported.body.caps.length, 1);

  await Rule.deleteMany({});
  await Cap.deleteMany({});

  const imported = await agent.post("/api/ops/import").send(exported.body);
  assert.equal(imported.status, 200);
  assert.equal(imported.body.rulesImported, 1);
  assert.equal(imported.body.capsImported, 1);

  const rules = await Rule.find().lean();
  assert.equal(rules.length, 1);
  assert.equal(rules[0].note, "roundtrip-test");
  assert.equal(rules[0].isDemoFixture, false); // forced, even though the export carried true
  assert.notEqual(String(rules[0]._id), String(rule._id)); // fresh id, not an overwrite

  const caps = await Cap.find().lean();
  assert.equal(caps.length, 1);
  assert.equal(caps[0].limit, 500);
  assert.notEqual(String(caps[0]._id), String(cap._id));
});

test("import rejects an unsupported exportVersion", async () => {
  const res = await agent.post("/api/ops/import").send({ exportVersion: 99 });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "unsupported_export_version");
});

test("import restores Settings fields from the export", async () => {
  const exported = await agent.get("/api/ops/export");
  const settingsPatch = { ...exported.body.settings, retentionDays: 42 };
  const res = await agent.post("/api/ops/import").send({ exportVersion: 1, settings: settingsPatch });
  assert.equal(res.status, 200);

  const gov = await agent.get("/api/governance");
  assert.equal(gov.body.retentionDays, 42);
});

test("support-bundle never includes a captured request payload, even though one is stored", async () => {
  await RequestRecord.create({
    requestId: "ops-bundle-payload-probe",
    application: "test-app", provider: "openai", model: "gpt-4o-mini",
    promptTokens: 10, completionTokens: 5, latencyMs: 42, status: "success",
    messages: [{ role: "user", content: FAKE_PAYLOAD }],
    responseText: FAKE_PAYLOAD,
  });
  const res = await agent.post("/api/ops/support-bundle");
  assert.equal(res.status, 200);
  assert.ok(!JSON.stringify(res.body).includes(FAKE_PAYLOAD));
  assert.equal(res.body.requestStats.total, 1); // counted, just not the payload text
});

test("support-bundle drops AuditLog.changes entirely, even though one holds something sensitive", async () => {
  await AuditLog.create({
    action: "rule.create", entity: "rule", entityId: "abc",
    changes: { note: FAKE_AUDIT_CHANGE }, actor: { id: "admin-1", email: "admin@test", role: "administrator" },
  });
  const res = await agent.post("/api/ops/support-bundle");
  assert.equal(res.status, 200);
  assert.ok(!JSON.stringify(res.body).includes(FAKE_AUDIT_CHANGE));
  assert.equal(res.body.recentAudit.length, 1);
  assert.equal(res.body.recentAudit[0].action, "rule.create");
  assert.equal(res.body.recentAudit[0].changes, undefined);
});

test("support-bundle includes disk usage and masked config, no crash if statfs is unavailable", async () => {
  const res = await agent.post("/api/ops/support-bundle");
  assert.equal(res.status, 200);
  assert.ok(res.body.disk); // either real numbers or a degraded {error} shape — never throws
  assert.equal(typeof res.body.config, "string"); // config.describe()'s boot-banner text
});
