"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const pricing = require("../../src/pricing/registry");
const aiPolicy = require("../../src/routing/aiPolicy");

// By default the AI policy is authoritative: a request routes to exactly the model the policy
// assigns for its task type — never a per-request "difficulty" re-pick to a model the operator
// didn't choose. That silent re-pick is the reported black box; it must be opt-in.

test("authoritative by default: returns the assigned model, ignoring difficulty", () => {
  const orig = pricing.getModel;
  pricing.getModel = (id) => ({ provider: "anthropic", id, chatCapable: true, inputPer1M: 3 });
  try {
    const map = { "document-analysis": "claude-sonnet-4-6" };
    const eff = { liveIds: ["anthropic", "gemini"] };
    // Difficulty differs from the task's usual tier, but with adjust off nothing is swapped.
    const hit = aiPolicy.resolveModel({ map, taskType: "document-analysis", difficulty: "mid", eff });
    assert.deepEqual(hit, { provider: "anthropic", model: "claude-sonnet-4-6" });
  } finally { pricing.getModel = orig; }
});

test("authoritative + unmapped task → null (caller falls through to the default model)", () => {
  const hit = aiPolicy.resolveModel({
    map: {}, taskType: "some-unmapped-task", difficulty: "mid", eff: { liveIds: ["anthropic"] },
  });
  assert.equal(hit, null);
});

test("adjust: true still guards — no eff/liveIds means it keeps the base pick", () => {
  const orig = pricing.getModel;
  pricing.getModel = (id) => ({ provider: "anthropic", id, chatCapable: true, inputPer1M: 3 });
  try {
    const map = { "document-analysis": "claude-sonnet-4-6" };
    const hit = aiPolicy.resolveModel({ map, taskType: "document-analysis", difficulty: "mid", eff: null, adjust: true });
    assert.deepEqual(hit, { provider: "anthropic", model: "claude-sonnet-4-6" });
  } finally { pricing.getModel = orig; }
});
