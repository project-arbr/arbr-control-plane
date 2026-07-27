"use strict";
// Regression tests for the silent model-pin swap.
//
// Reported: a client POSTed { "model": "deepseek.v3.2" } — a bare ID for a model
// the registry stores region-scoped (ap-southeast-3/deepseek.v3.2). Arbr could not
// resolve it, silently served the default (kimi-k2.5), and told the operator "no
// model was pinned". A pin that cannot be honored must now be rejected, not swapped.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { resolveExplicit } = require("../../src/gateway/handler");
const { rankSuggestions } = require("../../src/pricing/registry");

// resolveExplicit only consults pricing.getModel for models that ARE in the
// registry; every case below is unknown-to-registry (the empty test cache) or
// provider-hinted, so no DB is needed.
const eff = { liveIds: ["bedrock-nova", "openai"] };

test("no model pinned defers to the router", () => {
  assert.deepEqual(resolveExplicit({}, eff), { kind: "defer" });
  assert.deepEqual(resolveExplicit({ model: "auto" }, eff), { kind: "defer" });
  assert.deepEqual(resolveExplicit({ model: "  " }, eff), { kind: "defer" });
});

// The exact reported payload.
test("a bare region-scoped model with no provider is unresolved, not deferred", () => {
  const r = resolveExplicit({ model: "deepseek.v3.2" }, eff);
  assert.equal(r.kind, "unresolved", "must NOT collapse to defer — that was the bug");
  assert.equal(r.reason, "unknown-model");
  assert.equal(r.model, "deepseek.v3.2");
});

test("an unknown model routed to a LIVE provider is a valid pass-through pin", () => {
  const r = resolveExplicit({ model: "deepseek.v3.2", provider: "bedrock-nova" }, eff);
  assert.equal(r.kind, "pin");
  assert.equal(r.served.provider, "bedrock-nova");
  assert.equal(r.served.model, "deepseek.v3.2");
  assert.equal(r.served.knownPricing, false); // unknown to registry, still served
});

test("a pin to a provider that is not connected is unresolved", () => {
  const r = resolveExplicit({ model: "some-model", provider: "cohere" }, eff);
  assert.equal(r.kind, "unresolved");
  assert.equal(r.reason, "provider-not-connected");
  assert.equal(r.provider, "cohere");
});

// The "did you mean" that makes the bare-vs-region-scoped mistake self-correcting.
test("rankSuggestions floats the region-scoped variants of a bare id", () => {
  const models = [
    { id: "ap-southeast-3/deepseek.v3.2", provider: "bedrock-nova" },
    { id: "us-east-1/deepseek.v3.2", provider: "bedrock-nova" },
    { id: "gpt-4o-mini", provider: "openai" },
    { id: "claude-haiku-4-5", provider: "anthropic" },
  ];
  const out = rankSuggestions("deepseek.v3.2", models, { liveIds: ["bedrock-nova"] });
  assert.ok(out.includes("ap-southeast-3/deepseek.v3.2"));
  assert.ok(out.includes("us-east-1/deepseek.v3.2"));
  assert.ok(!out.includes("gpt-4o-mini"), "unrelated models must not be suggested");
});

test("rankSuggestions prefers reachable providers", () => {
  const models = [
    { id: "eu-north-1/deepseek.v3.2", provider: "bedrock-offline" }, // not live
    { id: "ap-southeast-3/deepseek.v3.2", provider: "bedrock-nova" }, // live
  ];
  const out = rankSuggestions("deepseek.v3.2", models, { liveIds: ["bedrock-nova"] });
  assert.equal(out[0], "ap-southeast-3/deepseek.v3.2", "the reachable one ranks first");
});

test("rankSuggestions returns nothing for an empty query or no matches", () => {
  assert.deepEqual(rankSuggestions("", [{ id: "x", provider: "p" }]), []);
  assert.deepEqual(rankSuggestions("zzz", [{ id: "gpt-4o", provider: "openai" }]), []);
});
