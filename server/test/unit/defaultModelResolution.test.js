"use strict";
// Regression tests for the silent default-model swap.
//
// Reported symptom: Settings showed a default of moonshotai.kimi-k2.5 on
// bedrock-nova, but the gateway served us.amazon.nova-lite-v1:0 — the provider's
// hardcoded built-in default — with nothing logged or surfaced anywhere.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { decideDefaultModel } = require("../../src/providers/connections");
const { pushOverride } = require("../../src/gateway/explain");

const PROVIDER_DEFAULTS = {
  "bedrock-nova": "us.amazon.nova-lite-v1:0",
  openai: "gpt-4o-mini",
  moonshot: "moonshot-v1-8k",
};
const lookupFrom = (byId) => (id) => byId[id] || null;

test("a configured model on the default provider is honored", () => {
  const r = decideDefaultModel({
    configured: "moonshotai.kimi-k2.5",
    defaultProvider: "bedrock-nova",
    lookup: lookupFrom({ "moonshotai.kimi-k2.5": { provider: "bedrock-nova" } }),
    providerDefaults: PROVIDER_DEFAULTS,
  });
  assert.equal(r.defaultModel, "moonshotai.kimi-k2.5");
  assert.equal(r.issue, null);
});

test("a model missing from the registry falls back BUT reports why", () => {
  const r = decideDefaultModel({
    configured: "moonshotai.kimi-k2.5",
    defaultProvider: "bedrock-nova",
    lookup: lookupFrom({}), // disabled, unsynced, or a stale replica cache
    providerDefaults: PROVIDER_DEFAULTS,
  });
  assert.equal(r.defaultModel, "us.amazon.nova-lite-v1:0");
  assert.equal(r.issue.reason, "not-in-registry");
  assert.equal(r.issue.configured, "moonshotai.kimi-k2.5");
  assert.equal(r.issue.serving, "us.amazon.nova-lite-v1:0", "the issue must name what is actually served");
});

test("a model belonging to another provider falls back BUT reports why", () => {
  const r = decideDefaultModel({
    configured: "moonshotai.kimi-k2.5",
    defaultProvider: "bedrock-nova",
    lookup: lookupFrom({ "moonshotai.kimi-k2.5": { provider: "moonshot" } }),
    providerDefaults: PROVIDER_DEFAULTS,
  });
  assert.equal(r.defaultModel, "us.amazon.nova-lite-v1:0");
  assert.equal(r.issue.reason, "provider-mismatch");
  assert.equal(r.issue.modelProvider, "moonshot");
});

test("no configured default is not an issue, just the provider default", () => {
  const r = decideDefaultModel({
    configured: null,
    defaultProvider: "bedrock-nova",
    lookup: lookupFrom({}),
    providerDefaults: PROVIDER_DEFAULTS,
  });
  assert.equal(r.defaultModel, "us.amazon.nova-lite-v1:0");
  assert.equal(r.issue, null, "an unset default is normal, not a misconfiguration");
});

test("an unknown provider yields no model rather than throwing", () => {
  const r = decideDefaultModel({
    configured: null,
    defaultProvider: "nope",
    lookup: lookupFrom({}),
    providerDefaults: PROVIDER_DEFAULTS,
  });
  assert.equal(r.defaultModel, null);
});

// The reported request showed only "gpt-4o-mini is opted out…", with no trace of
// the allowed-set swap that introduced gpt-4o-mini in the first place.
test("pushOverride keeps the whole chain, not just the last step", () => {
  const explain = {};
  pushOverride(explain, { type: "allowed", from: "us.amazon.nova-lite-v1:0", to: "gpt-4o-mini" });
  pushOverride(explain, { type: "optout", from: "gpt-4o-mini", to: "us.amazon.nova-lite-v1:0" });

  assert.equal(explain.overrides.length, 2);
  assert.equal(explain.overrides[0].type, "allowed");
  assert.equal(explain.overrides[1].type, "optout");
  // Back-compat: existing readers (OTel attributes, older records) use `override`.
  assert.equal(explain.override.type, "optout");
});

test("pushOverride tolerates a missing explain object", () => {
  assert.doesNotThrow(() => pushOverride(null, { type: "fallback" }));
});
