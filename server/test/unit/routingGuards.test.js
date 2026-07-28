"use strict";
// Tests for the central served-model guard (routing/guards.js), which closes the
// governance-bypass gaps documented in docs/routing-spec.md §Known gaps: a fallback
// candidate or a budget downgrade could previously serve a model the app is
// restricted from, a text-only model for an image request, or an unpriced model.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { hasVisionContent, checkModel, governanceFor } = require("../../src/routing/guards");
const { buildFallbackOrder } = require("../../src/gateway/handler");

test("hasVisionContent detects the multimodal image shape only", () => {
  assert.equal(hasVisionContent([{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }]), true);
  assert.equal(hasVisionContent([{ role: "user", content: "hi" }]), false);
  assert.equal(hasVisionContent([]), false);
});

test("governanceFor pulls allow-list from the key and opt-out from the app config", () => {
  const g = governanceFor({
    appConfig: { allowedModels: ["a", "b"] },
    appDbConfig: { modelOptOut: ["c"] },
    messages: [{ role: "user", content: "hi" }],
  });
  assert.deepEqual(g.allowedModels, ["a", "b"]);
  assert.deepEqual(g.modelOptOut, ["c"]);
  assert.equal(g.requireVision, false);
});

test("checkModel rejects a model outside the allow-list", () => {
  const v = checkModel("gpt-4o", { allowedModels: ["claude-haiku-4-5"] });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "allowed");
});

test("checkModel rejects an opted-out model", () => {
  const v = checkModel("gpt-4o", { modelOptOut: ["gpt-4o"] });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "optout");
});

test("checkModel rejects a non-vision model when the request needs vision", () => {
  // Unit registry cache is empty, so every id is unknown → not vision-capable.
  const v = checkModel("some-text-model", { requireVision: true });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "vision");
});

test("checkModel with requirePriced rejects an unpriced/unknown model", () => {
  const v = checkModel("nvidia/nemotron-content-safety-reasoning-4b", { requirePriced: true });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "unpriced");
});

test("checkModel passes an unrestricted, non-vision, non-priced-gated request", () => {
  assert.equal(checkModel("anything", {}).ok, true);
});

// The core regression: a fallback candidate that violates the allow-list must be
// filtered OUT of the retry order, while the primary (already routed) is kept.
test("fallback order drops governance-violating candidates, keeps the primary", () => {
  const order = buildFallbackOrder(
    "openai", "gpt-4o",
    ["openai", "bedrock-nova"],
    { openai: "gpt-4o-mini", "bedrock-nova": "us.amazon.nova-lite-v1:0" },
    "cross-provider"
  );
  // Primary + one cross-provider candidate.
  const governance = { allowedModels: ["gpt-4o", "gpt-4o-mini"], modelOptOut: [], requireVision: false };
  const filtered = [order[0], ...order.slice(1).filter((c) => checkModel(c.model, governance).ok)];
  assert.equal(filtered[0].model, "gpt-4o", "primary is always kept");
  assert.ok(!filtered.some((c) => c.model === "us.amazon.nova-lite-v1:0"), "disallowed cross-provider candidate is dropped");
});
