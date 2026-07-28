"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { _goalWeight } = require("../../src/routing/aiPolicy");

test('goal="cost" always returns 0.30', () => {
  assert.equal(_goalWeight("cost"), 0.30);
  assert.equal(_goalWeight("cost", "premium"), 0.30);
});

test('goal="quality" always returns 0.05', () => {
  assert.equal(_goalWeight("quality"), 0.05);
  assert.equal(_goalWeight("quality", "light"), 0.05);
});

test('goal="balanced" + tier "light" returns 0.20', () => {
  assert.equal(_goalWeight("balanced", "light"), 0.20);
});

test('goal="balanced" + tier "premium" returns 0.10', () => {
  assert.equal(_goalWeight("balanced", "premium"), 0.10);
});

test('goal="balanced" + unknown tier returns 0.25 fallback', () => {
  assert.equal(_goalWeight("balanced", "unknown"), 0.25);
});

test("goal unset (undefined) behaves like balanced", () => {
  assert.equal(_goalWeight(undefined, "light"), 0.20);
  assert.equal(_goalWeight(undefined, "unknown"), 0.25);
});

// Regression: a model with no/zero price used to score as free (cheapestCost/0.001
// → max cost score) and win cost-weighted selection, which is how a 4B content-safety
// model beat an explicitly-assigned claude for "document analysis". pricedPool keeps
// unpriced models out of auto-selection.
const { _pricedPool } = require("../../src/routing/aiPolicy");

test("pricedPool drops models with null or zero input price", () => {
  const models = [
    { id: "claude-sonnet-4-6", inputPer1M: 3.0 },
    { id: "nova-lite", inputPer1M: 0.06 },
    { id: "nvidia/nemotron-content-safety-reasoning-4b", inputPer1M: null }, // unpriced
    { id: "free-junk", inputPer1M: 0 },
  ];
  const out = _pricedPool(models).map((m) => m.id);
  assert.deepEqual(out.sort(), ["claude-sonnet-4-6", "nova-lite"]);
});

test("pricedPool falls back to the full list when nothing is priced (never empties)", () => {
  const models = [
    { id: "a", inputPer1M: null },
    { id: "b", inputPer1M: 0 },
  ];
  assert.equal(_pricedPool(models).length, 2, "an all-unpriced pool is returned intact rather than empty");
});

test("pricedPool keeps every priced model", () => {
  const models = [{ id: "a", inputPer1M: 0.1 }, { id: "b", inputPer1M: 5 }];
  assert.equal(_pricedPool(models).length, 2);
});
