"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { analyzeGroups } = require("../../src/recommend/engine");

const deps = {
  isPremium: (m) => m === "premium",
  suggestLightTarget: (m) => (m === "premium" ? { provider: "x", model: "light" } : null),
  costFor: () => ({ totalCost: 1 }),
  minRequests: 20,
};

test("analyzeGroups surfaces premium-on-unmarked-task as a hidden opportunity", () => {
  const groups = [
    { taskType: "entity-extraction", model: "premium", requests: 100, promptTokens: 1000, completionTokens: 100, currentCost: 9 },
    { taskType: "classification", model: "premium", requests: 100, promptTokens: 500, completionTokens: 50, currentCost: 5 }, // cheap → already flagged
    { taskType: "faq", model: "light", requests: 100, promptTokens: 100, completionTokens: 10, currentCost: 2 }, // not premium
    { taskType: "entity-extraction", model: "premium", requests: 5, promptTokens: 10, completionTokens: 1, currentCost: 1 }, // below min
  ];
  const a = analyzeGroups(groups, new Set(["classification", "faq"]), deps);

  assert.equal(a.unmarkedOpportunities.length, 1);
  assert.equal(a.unmarkedOpportunities[0].taskType, "entity-extraction");
  assert.equal(a.unmarkedOpportunities[0].projectedSavings, 8); // 9 - 1
  assert.equal(a.flaggedGroups, 1); // classification (cheap + premium)
  assert.deepEqual(a.suggestMarkCheap, ["entity-extraction"]);
  assert.equal(a.analyzedRequests, 305);
  assert.equal(a.analyzedCost, 17);
  assert.equal(a.unmarkedPotentialSavings, 8);
});

test("analyzeGroups returns no opportunities when premium tasks are already marked cheap", () => {
  const groups = [{ taskType: "extraction", model: "premium", requests: 100, promptTokens: 1, completionTokens: 1, currentCost: 9 }];
  const a = analyzeGroups(groups, new Set(["extraction"]), deps);
  assert.equal(a.unmarkedOpportunities.length, 0);
  assert.equal(a.flaggedGroups, 1);
});
