"use strict";
// Integration: the dry-run route explainer (POST /api/routing/explain via explainRoute).
// Proves the preview runs the REAL routing precedence with no provider call and no
// billable classification, and returns the same decision live traffic would get.
// Uses MongoMemoryServer; skips cleanly if it cannot start.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

let mongod, skip = false;
let explainRoute, registry, ruleEngine, Settings, Rule, eff;

before(async () => {
  try {
    const { MongoMemoryServer } = require("mongodb-memory-server");
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
  } catch (err) {
    skip = true;
    console.warn("[routeExplain] skipping — no in-memory Mongo:", err.message);
    return;
  }
  const ModelEntry = require("../../src/models/ModelEntry");
  registry = require("../../src/pricing/registry");
  ruleEngine = require("../../src/routing/ruleEngine");
  Settings = require("../../src/models/Settings");
  Rule = require("../../src/models/Rule");
  ({ explainRoute } = require("../../src/routing/explainRoute"));

  await ModelEntry.create([
    { id: "gpt-4o", provider: "openai", inputPer1M: 2.5, outputPer1M: 10, tier: "premium", enabled: true, chatCapable: true, supportsVision: true },
    { id: "gpt-4o-mini", provider: "openai", inputPer1M: 0.15, outputPer1M: 0.6, tier: "light", enabled: true, chatCapable: true, supportsVision: true },
    { id: "text-only-8b", provider: "openai", inputPer1M: 0.05, outputPer1M: 0.1, tier: "light", enabled: true, chatCapable: true, supportsVision: false },
  ]);
  await registry.reload();
  eff = { liveIds: ["openai"], defaultProvider: "openai", defaultModel: "gpt-4o-mini" };
  await Settings.deleteMany({});
  await ruleEngine.setRoutingMode("off");
});

after(async () => {
  if (skip) return;
  await mongoose.disconnect();
  await mongod.stop();
});

test("explicit pin is previewed as served directly", async (t) => {
  if (skip) return t.skip("no mongo");
  const r = await explainRoute({ model: "gpt-4o" }, { eff });
  assert.equal(r.model, "gpt-4o");
  assert.equal(r.routingDecision, "explicit");
  assert.equal(r.routingExplain.basis, "explicit");
});

test("auto with no rule falls to the default (passthrough)", async (t) => {
  if (skip) return t.skip("no mongo");
  const r = await explainRoute({ model: "auto", application: "billing" }, { eff });
  assert.equal(r.model, "gpt-4o-mini");
  assert.equal(r.routingDecision, "passthrough");
});

test("a matching rule is previewed as the rule decision", async (t) => {
  if (skip) return t.skip("no mongo");
  await Rule.create({ condition: { application: "billing" }, target: { provider: "openai", model: "gpt-4o" }, enabled: true, priority: 0 });
  ruleEngine.invalidate();
  const r = await explainRoute({ model: "auto", application: "billing" }, { eff });
  assert.equal(r.routingDecision, "rule");
  assert.equal(r.model, "gpt-4o");
  await Rule.deleteMany({});
  ruleEngine.invalidate();
});

test("an image request pinned to a non-vision model is rejected in preview", async (t) => {
  if (skip) return t.skip("no mongo");
  // Explicit pins skip the vision guard by design, so force it via a rule → non-vision
  // model, then send an image. The guard runs on the routed (non-explicit) model.
  await Rule.create({ condition: { application: "vis" }, target: { provider: "openai", model: "text-only-8b" }, enabled: true, priority: 0 });
  ruleEngine.invalidate();
  await assert.rejects(
    () => explainRoute({ model: "auto", application: "vis", hasImage: true }, { eff }),
    (err) => err.code === "vision_not_supported"
  );
  await Rule.deleteMany({});
  ruleEngine.invalidate();
});

test("preview never makes a billable classification (classifiedBy is not 'ai')", async (t) => {
  if (skip) return t.skip("no mongo");
  await ruleEngine.setRoutingMode("ai");
  const r = await explainRoute({ model: "auto", application: "billing" }, { eff });
  assert.notEqual(r.classifiedBy, "ai", "dry-run must not invoke the LLM classifier");
  await ruleEngine.setRoutingMode("off");
});

// ── credential pinning (multi-key) ───────────────────────────────────────────
//
// Which of a provider's API keys serves a request: a rule's pin beats an application's,
// and a pin naming a key that no longer exists degrades to the provider's default key
// rather than failing the request.

// An eff snapshot carrying two openai keys, shaped as connections.compute() builds it.
const multiKeyEff = () => ({
  liveIds: ["openai"], defaultProvider: "openai", defaultModel: "gpt-4o-mini",
  providers: {
    openai: {
      credential: { apiKey: "sk-default" },
      defaultModel: "gpt-4o-mini", authType: "apiKey", source: "stored",
      defaultAlias: "default",
      credentials: {
        default: { credential: { apiKey: "sk-default" }, source: "stored" },
        batch: { credential: { apiKey: "sk-batch" }, source: "stored" },
      },
    },
  },
});

test("with no pin, the provider's default key is recorded and nothing is explained", async (t) => {
  if (skip) return t.skip("no mongo");
  const r = await explainRoute({ model: "auto", application: "billing" }, { eff: multiKeyEff() });
  assert.equal(r.credentialAlias, "default");
  assert.equal(r.routingExplain.credential, undefined, "no pin means nothing worth narrating");
});

test("an application-level pin selects that key", async (t) => {
  if (skip) return t.skip("no mongo");
  const r = await explainRoute(
    { model: "auto", application: "billing" },
    { eff: multiKeyEff(), appDbConfig: { credentialAliases: { openai: "batch" } } }
  );
  assert.equal(r.credentialAlias, "batch");
  assert.equal(r.routingExplain.credential.source, "app");
  assert.equal(r.routingExplain.credential.fellBack, false);
});

test("a rule pin beats an application pin", async (t) => {
  if (skip) return t.skip("no mongo");
  await Rule.create({
    condition: { application: "billing" },
    target: { provider: "openai", model: "gpt-4o", credentialAlias: "default" },
    enabled: true, priority: 0,
  });
  ruleEngine.invalidate();
  const r = await explainRoute(
    { model: "auto", application: "billing" },
    { eff: multiKeyEff(), appDbConfig: { credentialAliases: { openai: "batch" } } }
  );
  assert.equal(r.routingDecision, "rule");
  assert.equal(r.credentialAlias, "default", "the rule's key wins over the application's");
  assert.equal(r.routingExplain.credential.source, "rule");
  await Rule.deleteMany({});
  ruleEngine.invalidate();
});

test("a pin naming a deleted key falls back to the default and says so", async (t) => {
  if (skip) return t.skip("no mongo");
  await Rule.create({
    condition: { application: "billing" },
    target: { provider: "openai", model: "gpt-4o", credentialAlias: "deleted-key" },
    enabled: true, priority: 0,
  });
  ruleEngine.invalidate();
  const r = await explainRoute({ model: "auto", application: "billing" }, { eff: multiKeyEff() });
  // The request still routes — a deleted key must not take the rule down with it.
  assert.equal(r.routingDecision, "rule");
  assert.equal(r.model, "gpt-4o");
  assert.equal(r.credentialAlias, "default");
  assert.equal(r.routingExplain.credential.requested, "deleted-key");
  assert.equal(r.routingExplain.credential.used, "default");
  assert.equal(r.routingExplain.credential.fellBack, true);
  await Rule.deleteMany({});
  ruleEngine.invalidate();
});

test("an eff with no credentials map (older snapshot) does not throw", async (t) => {
  if (skip) return t.skip("no mongo");
  const r = await explainRoute({ model: "auto", application: "billing" }, { eff });
  assert.equal(r.credentialAlias, null);
});
