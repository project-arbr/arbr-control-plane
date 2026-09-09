"use strict";
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { MongoMemoryServer } = require("mongodb-memory-server");
const mongoose = require("mongoose");
const express = require("express");
const supertest = require("supertest");

// Suppress dotenv warnings — no .env needed for tests.
process.env.ARBR_ADMIN_KEY = "";

const RequestRecord = require("../../src/models/RequestRecord");
const apiRoutes = require("../../src/api/routes");

let mongod;
let agent;

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
  await RequestRecord.deleteMany({});
});

function seedRecord(overrides = {}) {
  return RequestRecord.create({
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date("2024-03-15T10:00:00.000Z"),
    application: "test-app",
    provider: "openai",
    model: "gpt-4o-mini",
    status: "success",
    totalCost: 0.001,
    ...overrides,
  });
}

test("no records → 200 with header row only", async () => {
  const res = await agent.get("/api/requests/export");
  assert.equal(res.status, 200);
  assert.match(res.headers["content-type"], /text\/csv/);
  const lines = res.text.trim().split("\n");
  assert.equal(lines.length, 1, "only header row");
});

test("3 seed records → header + 3 data rows", async () => {
  await seedRecord();
  await seedRecord();
  await seedRecord();
  const res = await agent.get("/api/requests/export");
  assert.equal(res.status, 200);
  const lines = res.text.trim().split("\n");
  assert.equal(lines.length, 4, "header + 3 rows");
});

test("application field with comma is quoted in CSV", async () => {
  await seedRecord({ application: "acme, inc" });
  const res = await agent.get("/api/requests/export");
  assert.ok(res.text.includes('"acme, inc"'), "comma-containing value is quoted");
});

test("?application= filter returns only matching rows", async () => {
  await seedRecord({ application: "app-a" });
  await seedRecord({ application: "app-b" });
  await seedRecord({ application: "app-a" });
  const res = await agent.get("/api/requests/export?application=app-a");
  assert.equal(res.status, 200);
  const lines = res.text.trim().split("\n");
  assert.equal(lines.length, 3, "header + 2 matching rows");
});

test("Content-Disposition header is set for attachment download", async () => {
  const res = await agent.get("/api/requests/export");
  assert.match(res.headers["content-disposition"], /attachment/);
  assert.match(res.headers["content-disposition"], /requests\.csv/);
});

test("header row contains the expected 22 columns", async () => {
  const res = await agent.get("/api/requests/export");
  const header = res.text.split("\n")[0];
  const cols = header.split(",");
  assert.equal(cols.length, 22, "22 columns in header");
  assert.ok(cols.includes("timestamp"), "timestamp column present");
  assert.ok(cols.includes("requestId"), "requestId column present");
  assert.ok(cols.includes("totalCost"), "totalCost column present");
  assert.ok(cols.includes("credentialAlias"), "credentialAlias column present (which provider key served the request)");
});

// ── filtering by provider key ────────────────────────────────────────────────
//
// Which of a provider's API keys served a request is a filterable dimension, so per-key
// spend can be isolated in the dashboard and the CSV.

test("facets list the provider keys seen in traffic, without a null entry", async () => {
  await seedRecord({ application: "app-a", credentialAlias: "prod-eu" });
  await seedRecord({ application: "app-a", credentialAlias: "batch" });
  await seedRecord({ application: "app-a", credentialAlias: null }); // unpinned / cache hit

  const facets = (await agent.get("/api/analytics/facets").expect(200)).body;
  assert.deepEqual(facets.credentialAliases, ["batch", "prod-eu"], "sorted, deduped");
  // A null would render as a blank option in the filter dropdown and read as a bug.
  assert.ok(!facets.credentialAliases.includes(null));
  assert.ok(!facets.credentialAliases.includes(""));
});

test("requests can be filtered to one provider key", async () => {
  await seedRecord({ application: "app-a", credentialAlias: "prod-eu", totalCost: 0.5 });
  await seedRecord({ application: "app-a", credentialAlias: "batch", totalCost: 0.25 });
  await seedRecord({ application: "app-a", credentialAlias: null, totalCost: 0.1 });

  const res = await agent.get("/api/requests?credentialAlias=prod-eu").expect(200);
  assert.equal(res.body.items.length, 1);
  assert.equal(res.body.items[0].credentialAlias, "prod-eu");
});

test("the CSV export honours the provider-key filter", async () => {
  await seedRecord({ application: "app-a", credentialAlias: "prod-eu" });
  await seedRecord({ application: "app-a", credentialAlias: "batch" });

  const res = await agent.get("/api/requests/export?credentialAlias=batch").expect(200);
  const lines = res.text.trim().split("\n");
  assert.equal(lines.length, 2, "header + the one matching row");
  assert.ok(lines[1].includes("batch"));
  assert.ok(!lines[1].includes("prod-eu"));
});
