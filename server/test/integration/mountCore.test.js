"use strict";
// P0c: mountCore()/buildApp() builds the whole app with injectable tenancy hooks. Requiring the
// core module must NOT boot the server (guarded by require.main), and building the app must NOT
// start background jobs (those live in start()). Default hooks keep the OSS server single-tenant.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const supertest = require("supertest");
const { mountCore } = require("../../src/cloud");

let mongod, skip = false;
before(async () => {
  try {
    const { MongoMemoryServer } = require("mongodb-memory-server");
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
  } catch { skip = true; }
});
after(async () => {
  if (mongoose.connection.readyState) await mongoose.disconnect();
  if (mongod) await mongod.stop();
});
function maybeSkip(t) { if (skip) { t.skip("MongoMemoryServer unavailable"); return true; } return false; }

test("mountCore() builds a working app with default single-tenant hooks", async (t) => {
  if (maybeSkip(t)) return;
  const app = mountCore(); // no hooks → single-tenant defaults
  const res = await supertest(app).get("/health");
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

test("the tenancy hooks run for gateway routes (below the seam) and scope the request", async (t) => {
  if (maybeSkip(t)) return;
  let resolved = 0, entitled = 0;
  const app = mountCore({
    resolveTenantDb: () => { resolved++; return mongoose.connection; },
    entitlements: () => { entitled++; return { plan: "test", features: null, limits: {}, seats: 1 }; },
  });
  const res = await supertest(app).get("/v1/task-types"); // a route below the tenancy middleware
  assert.equal(res.status, 200);
  assert.ok(resolved >= 1, "resolveTenantDb hook was invoked for a gateway route");
  assert.ok(entitled >= 1, "entitlements hook was invoked");
});

test("health checks are NOT tenant-scoped (they sit above the seam)", async (t) => {
  if (maybeSkip(t)) return;
  let resolved = 0;
  const app = mountCore({ resolveTenantDb: () => { resolved++; return mongoose.connection; } });
  await supertest(app).get("/health/ready");
  assert.equal(resolved, 0, "liveness/readiness must not depend on tenant resolution");
});
