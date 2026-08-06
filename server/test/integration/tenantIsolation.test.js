"use strict";
// P0 acceptance gate: with the request-scoped DB seam, the SAME model modules
// (require("../models/X")) resolve to a per-request connection, so two tenant databases never
// observe each other's data — Settings, provider credentials, keys, request records, caps.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { runWithConnection } = require("../../src/db/context");
const ProviderCredential = require("../../src/models/ProviderCredential");
const ApiKey = require("../../src/models/ApiKey");
const RequestRecord = require("../../src/models/RequestRecord");
const Cap = require("../../src/models/Cap");
const Settings = require("../../src/models/Settings");

let mongod, base, connA, connB, skip = false;

before(async () => {
  try {
    const { MongoMemoryServer } = require("mongodb-memory-server");
    mongod = await MongoMemoryServer.create();
    base = await mongoose.createConnection(mongod.getUri()).asPromise();
    // Database-per-tenant: two logical databases on one connection (as arbr-cloud does).
    connA = base.useDb("tenant_a", { useCache: true });
    connB = base.useDb("tenant_b", { useCache: true });
  } catch { skip = true; }
});
after(async () => {
  if (base) await base.close();
  if (mongod) await mongod.stop();
});
function maybeSkip(t) { if (skip) { t.skip("MongoMemoryServer unavailable"); return true; } return false; }

test("two tenant connections fully isolate model data (incl. provider credentials)", async (t) => {
  if (maybeSkip(t)) return;

  await runWithConnection(connA, async () => {
    await ProviderCredential.create({ provider: "openai", ciphertext: "SECRET-A", iv: "a", tag: "a" });
    await ApiKey.create({ name: "kA", application: "app-a", keyHash: "hashA", prefix: "ab_aaaa" });
    await RequestRecord.create({ requestId: "reqA", application: "app-a" });
    await Cap.create({ limit: 5 });
  });
  // Same provider id "openai" in tenant B — no unique-index collision because it is a different
  // database; and its secret must never bleed into A.
  await runWithConnection(connB, async () => {
    await ProviderCredential.create({ provider: "openai", ciphertext: "SECRET-B", iv: "b", tag: "b" });
    await ApiKey.create({ name: "kB", application: "app-b", keyHash: "hashB", prefix: "ab_bbbb" });
    await RequestRecord.create({ requestId: "reqB", application: "app-b" });
    await Cap.create({ limit: 99 });
  });

  await runWithConnection(connA, async () => {
    const cred = await ProviderCredential.findOne({ provider: "openai" }).lean();
    assert.equal(cred.ciphertext, "SECRET-A", "tenant A must never read tenant B's provider secret");
    assert.deepEqual((await ApiKey.find().lean()).map((k) => k.prefix), ["ab_aaaa"]);
    assert.deepEqual((await RequestRecord.find().lean()).map((r) => r.application), ["app-a"]);
    assert.deepEqual((await Cap.find().lean()).map((c) => c.limit), [5]);
  });
  await runWithConnection(connB, async () => {
    const cred = await ProviderCredential.findOne({ provider: "openai" }).lean();
    assert.equal(cred.ciphertext, "SECRET-B", "tenant B must never read tenant A's provider secret");
    assert.deepEqual((await ApiKey.find().lean()).map((k) => k.prefix), ["ab_bbbb"]);
    assert.deepEqual((await RequestRecord.find().lean()).map((r) => r.application), ["app-b"]);
    assert.deepEqual((await Cap.find().lean()).map((c) => c.limit), [99]);
  });
});

test("the same required model resolves to a different database per connection", async (t) => {
  if (maybeSkip(t)) return;
  const a = await runWithConnection(connA, () => ApiKey.countDocuments());
  const b = await runWithConnection(connB, () => ApiKey.countDocuments());
  assert.equal(a, 1);
  assert.equal(b, 1);
  assert.notEqual(connA.name, connB.name); // genuinely different databases
});

test("Settings.get()'s 5s cache is per tenant (cached settings never cross)", async (t) => {
  if (maybeSkip(t)) return;
  await runWithConnection(connA, async () => {
    const s = await Settings.get(); s.defaultProvider = "prov-A"; await s.save(); Settings.invalidateCache();
  });
  await runWithConnection(connB, async () => {
    const s = await Settings.get(); s.defaultProvider = "prov-B"; await s.save(); Settings.invalidateCache();
  });
  // Prime A's cache, then B's, then read A again — A must not have been overwritten by B's cache.
  assert.equal((await runWithConnection(connA, () => Settings.get())).defaultProvider, "prov-A");
  assert.equal((await runWithConnection(connB, () => Settings.get())).defaultProvider, "prov-B");
  assert.equal((await runWithConnection(connA, () => Settings.get())).defaultProvider, "prov-A");
});
