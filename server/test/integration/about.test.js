"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { MongoMemoryServer } = require("mongodb-memory-server");
const mongoose = require("mongoose");
const express = require("express");
const supertest = require("supertest");

process.env.ARBR_ADMIN_KEY = "";
const apiRoutes = require("../../src/api/routes");

let mongod, agent;
before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  const app = express(); app.use(express.json()); app.use("/api", apiRoutes);
  agent = supertest(app);
});
after(async () => { await mongoose.disconnect(); await mongod.stop(); });

test("GET /api/about returns 200 with a version (package.json resolves)", async () => {
  const res = await agent.get("/api/about");
  assert.equal(res.status, 200);
  assert.ok(res.body.version, "version should be present");
  assert.ok(res.body.name, "name should be present");
});
