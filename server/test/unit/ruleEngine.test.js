"use strict";
// Rule precedence + target validation (docs/routing-spec.md §Known gaps 3, 4).
// Overlapping enabled rules used to resolve in Mongo's natural order; now the order
// is deterministic (priority, then specificity, then _id), and a rule whose target
// provider is offline is skipped so routing falls through instead of dead-ending.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { _specificity, _sortRules, _targetServable } = require("../../src/routing/ruleEngine");

const rule = (over = {}) => ({
  _id: over._id || "000000000000000000000000",
  priority: over.priority ?? 0,
  condition: over.condition || {},
  target: over.target || { provider: "openai", model: "gpt-4o" },
});

test("specificity counts the set condition fields", () => {
  assert.equal(_specificity(rule({ condition: {} })), 0);
  assert.equal(_specificity(rule({ condition: { taskType: "coding" } })), 1);
  assert.equal(_specificity(rule({ condition: { taskType: "coding", application: "a", workflow: "w" } })), 3);
});

test("higher priority wins regardless of specificity", () => {
  const specific = rule({ _id: "a", priority: 1, condition: { taskType: "coding", application: "app", workflow: "w" } });
  const broad    = rule({ _id: "b", priority: 5, condition: { taskType: "coding" } });
  assert.equal(_sortRules([specific, broad])[0]._id, "b", "priority 5 outranks priority 1");
});

test("equal priority breaks toward the more specific rule", () => {
  const broad    = rule({ _id: "a", priority: 2, condition: { taskType: "coding" } });
  const specific = rule({ _id: "b", priority: 2, condition: { taskType: "coding", application: "app" } });
  assert.equal(_sortRules([broad, specific])[0]._id, "b", "more condition fields wins the tie");
});

test("equal priority and specificity break by _id (stable, deterministic)", () => {
  const r1 = rule({ _id: "bbb", priority: 0, condition: { taskType: "x" } });
  const r2 = rule({ _id: "aaa", priority: 0, condition: { taskType: "y" } });
  assert.equal(_sortRules([r1, r2])[0]._id, "aaa");
});

test("sort is a pure copy — input array is not mutated", () => {
  const input = [rule({ _id: "a", priority: 1 }), rule({ _id: "b", priority: 2 })];
  const before = input.map((r) => r._id);
  _sortRules(input);
  assert.deepEqual(input.map((r) => r._id), before);
});

test("targetServable skips a rule whose provider is not connected", () => {
  const eff = { liveIds: ["openai", "anthropic"] };
  assert.equal(_targetServable(rule({ target: { provider: "openai", model: "gpt-4o" } }), eff), true);
  assert.equal(_targetServable(rule({ target: { provider: "cohere", model: "command-r" } }), eff), false);
});

test("targetServable allows an unknown model on a LIVE provider (pass-through)", () => {
  const eff = { liveIds: ["bedrock-nova"] };
  // model not in the registry, but provider connected — legitimate pass-through
  assert.equal(_targetServable(rule({ target: { provider: "bedrock-nova", model: "brand-new-model" } }), eff), true);
});

test("targetServable preserves old behavior when no eff is supplied", () => {
  assert.equal(_targetServable(rule({ target: { provider: "anything", model: "x" } }), null), true);
});
