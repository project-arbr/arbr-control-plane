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
