"use strict";
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { MongoMemoryServer } = require("mongodb-memory-server");
const mongoose = require("mongoose");
const express = require("express");
const supertest = require("supertest");

process.env.ARBR_ADMIN_KEY = "";

const RequestRecord = require("../../src/models/RequestRecord");
const apiRoutes = require("../../src/api/routes");

let mongod;
let agent;

function buildApp() {
  const app = express();
  app.use(express.json());
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

test("no records → 200 with empty array", async () => {
  const res = await agent.get("/api/analytics/timeseries");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, []);
});

test("records on 3 different days → 3 rows sorted ascending", async () => {
  await seedRecord({ timestamp: new Date("2024-03-01T12:00:00Z") });
  await seedRecord({ timestamp: new Date("2024-03-03T12:00:00Z") });
  await seedRecord({ timestamp: new Date("2024-03-02T12:00:00Z") });
  const res = await agent.get("/api/analytics/timeseries");
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 3);
  assert.equal(res.body[0].date, "2024-03-01");
  assert.equal(res.body[1].date, "2024-03-02");
  assert.equal(res.body[2].date, "2024-03-03");
});

test("each row has expected shape: date, requests, cost, failures", async () => {
  await seedRecord({ timestamp: new Date("2024-03-15T10:00:00Z"), totalCost: 0.005 });
  const res = await agent.get("/api/analytics/timeseries");
  const row = res.body[0];
  assert.ok("date" in row, "date key present");
  assert.ok("requests" in row, "requests key present");
  assert.ok("cost" in row, "cost key present");
  assert.ok("failures" in row, "failures key present");
});

test("?bucket=day produces YYYY-MM-DD date format", async () => {
  await seedRecord({ timestamp: new Date("2024-03-15T10:00:00Z") });
  const res = await agent.get("/api/analytics/timeseries?bucket=day");
  assert.match(res.body[0].date, /^\d{4}-\d{2}-\d{2}$/);
});

test("?bucket=hour produces YYYY-MM-DDTHH date format", async () => {
  await seedRecord({ timestamp: new Date("2024-03-15T10:00:00Z") });
  const res = await agent.get("/api/analytics/timeseries?bucket=hour");
  assert.match(res.body[0].date, /^\d{4}-\d{2}-\d{2}T\d{2}$/);
});

test("?from= filter limits returned range", async () => {
  await seedRecord({ timestamp: new Date("2024-03-01T12:00:00Z") });
  await seedRecord({ timestamp: new Date("2024-03-15T12:00:00Z") });
  const res = await agent.get("/api/analytics/timeseries?from=2024-03-10T00:00:00Z");
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].date, "2024-03-15");
});

test("failure status records are counted in failures field", async () => {
  await seedRecord({ timestamp: new Date("2024-03-15T10:00:00Z"), status: "success" });
  await seedRecord({ timestamp: new Date("2024-03-15T11:00:00Z"), status: "failure" });
  await seedRecord({ timestamp: new Date("2024-03-15T12:00:00Z"), status: "failure" });
  const res = await agent.get("/api/analytics/timeseries");
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].requests, 3);
  assert.equal(res.body[0].failures, 2);
});
