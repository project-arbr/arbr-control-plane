"use strict";
// Integration: the named-provider-key API surface.
//
// Covers the two things most likely to go wrong operationally: a secret leaking into a
// response (these routes are the only ones that accept raw credentials), and deleting a key
// that routing still points at.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { MongoMemoryServer } = require("mongodb-memory-server");
const mongoose = require("mongoose");
const express = require("express");
const supertest = require("supertest");

process.env.ARBR_ADMIN_KEY = "";

const ProviderCredential = require("../../src/models/ProviderCredential");
const Rule = require("../../src/models/Rule");
const ApplicationConfig = require("../../src/models/ApplicationConfig");
const connections = require("../../src/providers/connections");
const apiRoutes = require("../../src/api/routes");

let mongod, agent;

const stubAdmin = (req, _res, next) => { req.user = { id: "t", email: "t@test", role: "administrator" }; next(); };
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(stubAdmin);
  app.use("/api", apiRoutes);
  return app;
}

// The provider used throughout. Deliberately NOT one with an env credential set in the
// test environment, so `stored` keys are the ones under test.
const P = "openai";
const openaiOf = (body) => body.providers.find((p) => p.provider === P);

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
  // The developer .env (loaded by dotenv during the requires above) may set OPENAI_API_KEY,
  // which would add an always-default "env" key to every assertion. Stored keys are what
  // most of these tests are about; env precedence has its own tests at the bottom, which
  // set the variable deliberately.
  delete process.env.OPENAI_API_KEY;
  await Promise.all([
    ProviderCredential.deleteMany({}), Rule.deleteMany({}), ApplicationConfig.deleteMany({}),
  ]);
  connections.invalidate();
});

test("the pre-multi-key PUT still writes the alias 'default'", async () => {
  // Back-compat: existing callers and scripts must keep working untouched.
  const res = await agent.put(`/api/connections/${P}`).send({ apiKey: "sk-aaaa1111" });
  assert.equal(res.status, 200);
  const rows = await ProviderCredential.find({ provider: P }).lean();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].alias, "default");
  assert.equal(rows[0].isDefault, true, "the first key is the provider's default");
});

test("a second key can be added under its own name", async () => {
  await agent.put(`/api/connections/${P}`).send({ apiKey: "sk-aaaa1111" });
  const res = await agent.post(`/api/connections/${P}/keys`).send({ alias: "Staging", apiKey: "sk-bbbb2222" });
  assert.equal(res.status, 200);

  const keys = openaiOf(res.body).keys;
  assert.deepEqual(keys.map((k) => k.alias).sort(), ["default", "staging"], "aliases are lowercased");
  assert.equal(keys.find((k) => k.alias === "default").isDefault, true,
    "adding a key must not silently move the default");
});

test("no response ever contains a secret, only last4", async () => {
  await agent.put(`/api/connections/${P}`).send({ apiKey: "sk-fixture-not-a-real-key-9999" });
  await agent.post(`/api/connections/${P}/keys`).send({ alias: "batch", apiKey: "sk-fixture-not-a-real-key-8888" });
  const res = await agent.get("/api/connections");
  const body = JSON.stringify(res.body);
  assert.ok(!body.includes("sk-fixture-not-a-real-key-9999"), "the stored secret leaked into a response");
  assert.ok(!body.includes("sk-fixture-not-a-real-key-8888"), "the stored secret leaked into a response");
  const keys = openaiOf(res.body).keys;
  assert.deepEqual(keys.map((k) => k.last4).sort(), ["8888", "9999"]);
});

test("'env' is reserved and rejected as a key name", async () => {
  const res = await agent.post(`/api/connections/${P}/keys`).send({ alias: "env", apiKey: "sk-x" });
  assert.equal(res.status, 400);
  assert.match(res.body.message, /reserved/);
});

test("a malformed key name is rejected", async () => {
  for (const alias of ["has space", "-leading", "a/b", ""]) {
    const res = await agent.post(`/api/connections/${P}/keys`).send({ alias, apiKey: "sk-x" });
    assert.equal(res.status, 400, `alias ${JSON.stringify(alias)} should be rejected`);
  }
});

test("a key can be promoted to default", async () => {
  await agent.put(`/api/connections/${P}`).send({ apiKey: "sk-aaaa1111" });
  await agent.post(`/api/connections/${P}/keys`).send({ alias: "batch", apiKey: "sk-bbbb2222" });
  const res = await agent.put(`/api/connections/${P}/keys/batch/default`);
  assert.equal(res.status, 200);
  const keys = openaiOf(res.body).keys;
  assert.equal(keys.find((k) => k.alias === "batch").isDefault, true);
  assert.equal(keys.find((k) => k.alias === "default").isDefault, false, "exactly one default");
});

test("deleting a key a RULE pins is refused, and names the rule", async () => {
  await agent.put(`/api/connections/${P}`).send({ apiKey: "sk-aaaa1111" });
  await agent.post(`/api/connections/${P}/keys`).send({ alias: "batch", apiKey: "sk-bbbb2222" });
  await Rule.create({
    condition: { taskType: "coding" },
    target: { provider: P, model: "gpt-4o", credentialAlias: "batch" },
    enabled: true,
  });

  const res = await agent.delete(`/api/connections/${P}/keys/batch`);
  assert.equal(res.status, 409);
  assert.equal(res.body.error, "alias_in_use");
  assert.equal(res.body.rules.length, 1);
  assert.equal(await ProviderCredential.countDocuments({ provider: P, alias: "batch" }), 1,
    "the key must still exist after a refused delete");
});

test("deleting a key an APPLICATION pins is refused, and names the application", async () => {
  await agent.put(`/api/connections/${P}`).send({ apiKey: "sk-aaaa1111" });
  await agent.post(`/api/connections/${P}/keys`).send({ alias: "batch", apiKey: "sk-bbbb2222" });
  await ApplicationConfig.create({ applicationName: "billing", credentialAliases: { [P]: "batch" } });

  const res = await agent.delete(`/api/connections/${P}/keys/batch`);
  assert.equal(res.status, 409);
  assert.deepEqual(res.body.applications, ["billing"]);
});

test("force removes a pinned key", async () => {
  await agent.put(`/api/connections/${P}`).send({ apiKey: "sk-aaaa1111" });
  await agent.post(`/api/connections/${P}/keys`).send({ alias: "batch", apiKey: "sk-bbbb2222" });
  await Rule.create({
    condition: { taskType: "coding" },
    target: { provider: P, model: "gpt-4o", credentialAlias: "batch" }, enabled: true,
  });
  const res = await agent.delete(`/api/connections/${P}/keys/batch?force=1`);
  assert.equal(res.status, 200);
  assert.equal(await ProviderCredential.countDocuments({ provider: P, alias: "batch" }), 0);
});

test("an unpinned key deletes without a confirmation step", async () => {
  await agent.put(`/api/connections/${P}`).send({ apiKey: "sk-aaaa1111" });
  await agent.post(`/api/connections/${P}/keys`).send({ alias: "batch", apiKey: "sk-bbbb2222" });
  const res = await agent.delete(`/api/connections/${P}/keys/batch`);
  assert.equal(res.status, 200);
  assert.deepEqual(openaiOf(res.body).keys.map((k) => k.alias), ["default"]);
});

test("removing the default key promotes a successor rather than going dark", async () => {
  await agent.put(`/api/connections/${P}`).send({ apiKey: "sk-aaaa1111" });
  await agent.post(`/api/connections/${P}/keys`).send({ alias: "batch", apiKey: "sk-bbbb2222" });
  const res = await agent.delete(`/api/connections/${P}/keys/default`);
  assert.equal(res.status, 200);
  const keys = openaiOf(res.body).keys;
  assert.equal(keys.length, 1);
  assert.equal(keys[0].alias, "batch");
  assert.equal(keys[0].isDefault, true, "the surviving key must become the default");
});

test("the pre-multi-key DELETE still disconnects the whole provider", async () => {
  await agent.put(`/api/connections/${P}`).send({ apiKey: "sk-aaaa1111" });
  await agent.post(`/api/connections/${P}/keys`).send({ alias: "batch", apiKey: "sk-bbbb2222" });
  const res = await agent.delete(`/api/connections/${P}`);
  assert.equal(res.status, 200);
  assert.equal(await ProviderCredential.countDocuments({ provider: P }), 0,
    "DELETE /connections/:provider must remove every key, not just the default");
});

test("replacing a key's secret keeps its name and its pins", async () => {
  await agent.put(`/api/connections/${P}`).send({ apiKey: "sk-aaaa1111" });
  await agent.post(`/api/connections/${P}/keys`).send({ alias: "batch", apiKey: "sk-bbbb2222" });
  const res = await agent.put(`/api/connections/${P}/keys/batch`).send({ apiKey: "sk-cccc3333" });
  assert.equal(res.status, 200);
  const key = openaiOf(res.body).keys.find((k) => k.alias === "batch");
  assert.equal(key.last4, "3333");
  assert.equal(await ProviderCredential.countDocuments({ provider: P }), 2, "no duplicate row");
});

// ── env precedence ───────────────────────────────────────────────────────────
//
// An environment credential stays the provider's default no matter what is stored, so an
// existing env-based deploy keeps serving exactly the key it served before multi-key.
// Stored keys sit alongside it and can be pinned explicitly.

test("an env credential is listed as a reserved, non-editable, always-default key", async () => {
  process.env.OPENAI_API_KEY = "sk-from-env-7777";
  connections.invalidate();
  try {
    await agent.put(`/api/connections/${P}`).send({ apiKey: "sk-stored-1111" });
    connections.invalidate();
    const res = await agent.get("/api/connections");
    const p = openaiOf(res.body);

    const env = p.keys.find((k) => k.alias === "env");
    assert.ok(env, "the environment credential should appear as a key");
    assert.equal(env.isDefault, true, "env outranks anything stored");
    assert.equal(env.editable, false, "an env key cannot be edited or removed from the console");
    assert.equal(env.last4, "7777");
    assert.ok(p.keys.some((k) => k.alias === "default"), "the stored key is still selectable");
    assert.ok(!JSON.stringify(res.body).includes("sk-from-env-7777"));
  } finally {
    delete process.env.OPENAI_API_KEY;
    connections.invalidate();
  }
});

test("promoting a stored key while env is set reports which key is actually effective", async () => {
  process.env.OPENAI_API_KEY = "sk-from-env-7777";
  connections.invalidate();
  try {
    await agent.put(`/api/connections/${P}`).send({ apiKey: "sk-stored-1111" });
    await agent.post(`/api/connections/${P}/keys`).send({ alias: "batch", apiKey: "sk-bbbb2222" });
    // effective() memoizes for 3s. Under load an earlier compute can still be live, so force
    // a recompute rather than depending on the writes above having invalidated recently.
    connections.invalidate();
    const res = await agent.put(`/api/connections/${P}/keys/batch/default`);
    assert.equal(res.status, 200);
    // The write succeeded, but env still wins. Saying so is the point — silently accepting
    // would leave the operator believing traffic had moved.
    assert.equal(res.body.effectiveDefault, "env");
  } finally {
    delete process.env.OPENAI_API_KEY;
    connections.invalidate();
  }
});
