"use strict";
// The governance route exposes and persists the OTLP tracing runtime overrides.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { MongoMemoryServer } = require("mongodb-memory-server");
const mongoose = require("mongoose");
const express = require("express");
const supertest = require("supertest");

process.env.ARBR_ADMIN_KEY = "";

const Settings = require("../../src/models/Settings");
const apiRoutes = require("../../src/api/routes");

let mongod, agent;

const stubAdmin = (req, _res, next) => { req.user = { id: "t", email: "t@t", role: "administrator" }; next(); };
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(stubAdmin);
  app.use("/api", apiRoutes);
  return app;
}

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("arbr-gov-otel"));
  agent = supertest(buildApp());
});
after(async () => { await mongoose.disconnect(); await mongod.stop(); });
beforeEach(async () => { await Settings.deleteMany({}); Settings.invalidateCache(); });

test("governance view reports the tracing config (env-driven otelConfigured)", async () => {
  const { body } = await agent.get("/api/governance").expect(200);
  // ARBR_OTEL_ENABLED is unset in this process, so tracing is not configured.
  assert.equal(body.otelConfigured, false);
  assert.equal(body.otelEndpoint, null);
  assert.equal(body.otelEnabled, null);           // null = use env default (on)
  assert.equal(body.otelCaptureContent, null);
});

test("PATCH persists the tracing overrides and they round-trip", async () => {
  await agent.patch("/api/governance")
    .send({ otelEnabled: false, otelSampleRatio: 0.25, otelCaptureContent: true })
    .expect(200);

  const s = await Settings.get();
  assert.equal(s.otel.enabled, false);
  assert.equal(s.otel.sampleRatio, 0.25);
  assert.equal(s.otel.captureContent, true);

  const { body } = await agent.get("/api/governance").expect(200);
  assert.equal(body.otelEnabled, false);
  assert.equal(body.otelSampleRatio, 0.25);
  assert.equal(body.otelCaptureContent, true);
});

test("sample ratio is clamped to 0..1 and null resets to the env default", async () => {
  await agent.patch("/api/governance").send({ otelSampleRatio: 5 }).expect(200);
  assert.equal((await Settings.get()).otel.sampleRatio, 1, "clamped to 1");

  await agent.patch("/api/governance").send({ otelSampleRatio: -2 }).expect(200);
  assert.equal((await Settings.get()).otel.sampleRatio, 0, "clamped to 0");

  await agent.patch("/api/governance").send({ otelEnabled: null, otelCaptureContent: null }).expect(200);
  const s = await Settings.get();
  assert.equal(s.otel.enabled, null, "null clears the soft override");
  assert.equal(s.otel.captureContent, null);
});
