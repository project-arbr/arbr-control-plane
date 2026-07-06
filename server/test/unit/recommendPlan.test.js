"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { planRecommendations } = require("../../src/recommend/engine");

const deps = {
  isPremium: (m) => m === "premium",
  suggestLightTarget: (m) => (m === "premium" ? { provider: "x", model: "light" } : null),
  costFor: () => ({ totalCost: 1 }),
  minRequests: 20,
};
const g = (o) => ({ application: null, taskType: "classification", model: "premium", provider: "openai",
  requests: 0, promptTokens: 10, completionTokens: 10, currentCost: 10, replayable: 0, ...o });

test("emits an app-scoped rec per app that clears the volume threshold", () => {
  const out = planRecommendations([
    g({ application: "app-a", requests: 100, currentCost: 10 }),
    g({ application: "app-b", requests: 50, currentCost: 6 }),
  ], new Set(["classification"]), deps);
  assert.equal(out.length, 2);
  assert.deepEqual(new Set(out.map((r) => r.application)), new Set(["app-a", "app-b"]));
  assert.ok(out.every((r) => r.dedupeKey.startsWith("premium_overuse:app-")));
});

test("falls back to ONE global rec only when no single app qualifies", () => {
  const out = planRecommendations([
    g({ application: "app-a", requests: 12, currentCost: 4 }),
    g({ application: "app-b", requests: 15, currentCost: 5 }), // both < 20, combined 27 >= 20
  ], new Set(["classification"]), deps);
  assert.equal(out.length, 1);
  assert.equal(out[0].application, null);
  assert.equal(out[0].requestCount, 27);
  assert.equal(out[0].dedupeKey, "premium_overuse:classification:premium");
});

test("no overlap: when an app qualifies, thin apps do not also produce a global rec", () => {
  const out = planRecommendations([
    g({ application: "app-a", requests: 100, currentCost: 10 }), // qualifies -> app-scoped
    g({ application: "app-b", requests: 5, currentCost: 1 }),    // thin -> dropped, NOT global
  ], new Set(["classification"]), deps);
  assert.equal(out.length, 1);
  assert.equal(out[0].application, "app-a");
});

test("skips non-premium models and non-cheap task types", () => {
  assert.equal(planRecommendations([g({ application: "a", requests: 100, model: "light" })], new Set(["classification"]), deps).length, 0);
  assert.equal(planRecommendations([g({ application: "a", requests: 100, taskType: "reasoning" })], new Set(["classification"]), deps).length, 0);
});
