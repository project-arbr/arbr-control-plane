"use strict";
// Integration: migrating provider_credentials from one-key-per-provider to many.
//
// This is the test that matters most in the multi-key change. Mongoose declares the new
// {provider, alias} unique index but never drops the old unique {provider} one, and the
// stale index is what rejects the SECOND key for a provider — with an E11000 that surfaces
// long after the deploy looked successful. So the assertions here are: the legacy index is
// gone, a second alias is actually insertable, and running twice changes nothing.
// Uses MongoMemoryServer; skips cleanly if it cannot start.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

let mongod, skip = false;
let ProviderCredential, migrateCredentialAliases, secrets;

const COLL = "provider_credentials";

before(async () => {
  try {
    const { MongoMemoryServer } = require("mongodb-memory-server");
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
  } catch (err) {
    skip = true;
    console.warn("[credentialAliasMigration] skipping — no in-memory Mongo:", err.message);
    return;
  }
  ProviderCredential = require("../../src/models/ProviderCredential");
  ({ migrateCredentialAliases } = require("../../src/maintenance/migrateCredentialAliases"));
  secrets = require("../../src/security/secrets");
});

after(async () => {
  if (mongod) { await mongoose.disconnect(); await mongod.stop(); }
});

// Recreate the pre-multi-key world: a unique index on {provider} alone, and a row with no
// alias field at all.
async function seedLegacy() {
  const db = mongoose.connection.db;
  await db.collection(COLL).drop().catch(() => {});
  await db.collection(COLL).createIndex({ provider: 1 }, { unique: true, name: "provider_1" });
  const enc = secrets.encrypt(JSON.stringify({ apiKey: "sk-legacy" }));
  await db.collection(COLL).insertOne({
    provider: "openai", ...enc, last4: "gacy", region: null,
    createdAt: new Date(), updatedAt: new Date(),
  });
}

const indexNames = async () =>
  (await mongoose.connection.db.collection(COLL).indexes()).map((i) => i.name);

test("backfills alias and drops the legacy unique index", async (t) => {
  if (skip) return t.skip("no in-memory Mongo");
  await seedLegacy();
  assert.ok((await indexNames()).includes("provider_1"), "precondition: legacy index exists");

  const out = await migrateCredentialAliases();

  assert.equal(out.error, null);
  assert.equal(out.backfilled, 1);
  assert.equal(out.droppedLegacyIndex, true);

  const row = await ProviderCredential.findOne({ provider: "openai" }).lean();
  assert.equal(row.alias, "default", "a pre-multi-key row is the provider's default key");
  assert.equal(row.isDefault, true);

  const names = await indexNames();
  assert.ok(!names.includes("provider_1"), "the legacy unique index must be gone");
  assert.ok(names.includes("provider_1_alias_1"), "the compound unique index must exist");
});

test("a second key for the same provider is insertable afterwards", async (t) => {
  if (skip) return t.skip("no in-memory Mongo");
  // The whole point of the migration. Before it, this throws E11000.
  const enc = secrets.encrypt(JSON.stringify({ apiKey: "sk-second" }));
  await ProviderCredential.create({ provider: "openai", alias: "staging", ...enc, last4: "cond" });
  const rows = await ProviderCredential.find({ provider: "openai" }).lean();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.alias).sort(), ["default", "staging"]);
});

test("the same alias twice on one provider is still rejected", async (t) => {
  if (skip) return t.skip("no in-memory Mongo");
  const enc = secrets.encrypt(JSON.stringify({ apiKey: "sk-dupe" }));
  await assert.rejects(
    () => ProviderCredential.create({ provider: "openai", alias: "staging", ...enc }),
    (err) => err.code === 11000,
    "the compound index must still enforce uniqueness per (provider, alias)"
  );
});

test("the same alias on a DIFFERENT provider is allowed", async (t) => {
  if (skip) return t.skip("no in-memory Mongo");
  const enc = secrets.encrypt(JSON.stringify({ apiKey: "sk-ant" }));
  await ProviderCredential.create({ provider: "anthropic", alias: "staging", ...enc });
  assert.equal(await ProviderCredential.countDocuments({ alias: "staging" }), 2);
});

test("a second run is a clean no-op", async (t) => {
  if (skip) return t.skip("no in-memory Mongo");
  const before = await ProviderCredential.find().lean();
  const out = await migrateCredentialAliases();
  assert.equal(out.error, null);
  assert.equal(out.backfilled, 0, "nothing left to backfill");
  assert.equal(out.droppedLegacyIndex, false, "nothing left to drop");
  const after = await ProviderCredential.find().lean();
  assert.equal(after.length, before.length);
  assert.ok((await indexNames()).includes("provider_1_alias_1"));
});

test("runs cleanly on a fresh install with no collection", async (t) => {
  if (skip) return t.skip("no in-memory Mongo");
  await mongoose.connection.db.collection(COLL).drop().catch(() => {});
  const out = await migrateCredentialAliases();
  assert.equal(out.error, null, "a missing collection must not be treated as a failure");
  assert.equal(out.backfilled, 0);
  assert.equal(out.droppedLegacyIndex, false);
});

test("a row already carrying an alias is left alone", async (t) => {
  if (skip) return t.skip("no in-memory Mongo");
  const enc = secrets.encrypt(JSON.stringify({ apiKey: "sk-keep" }));
  await ProviderCredential.create({ provider: "gemini", alias: "prod-eu", isDefault: true, ...enc });
  const out = await migrateCredentialAliases();
  assert.equal(out.backfilled, 0);
  const row = await ProviderCredential.findOne({ provider: "gemini" }).lean();
  assert.equal(row.alias, "prod-eu", "the migration must never rename an existing alias");
});
