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

test("header row contains the expected 21 columns", async () => {
  const res = await agent.get("/api/requests/export");
  const header = res.text.split("\n")[0];
  const cols = header.split(",");
  assert.equal(cols.length, 21, "21 columns in header");
  assert.ok(cols.includes("timestamp"), "timestamp column present");
  assert.ok(cols.includes("requestId"), "requestId column present");
  assert.ok(cols.includes("totalCost"), "totalCost column present");
});
