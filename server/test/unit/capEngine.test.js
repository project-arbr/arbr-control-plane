"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { _shouldWarn, _matches } = require("../../src/routing/capEngine");

test("below threshold returns false", () => {
  assert.equal(_shouldWarn(70, 100, 0.8), false);
});

test("at threshold exactly returns true", () => {
  assert.equal(_shouldWarn(80, 100, 0.8), true);
});

test("above threshold but below limit returns true", () => {
  assert.equal(_shouldWarn(90, 100, 0.8), true);
});

test("at limit (breached) returns false", () => {
  assert.equal(_shouldWarn(100, 100, 0.8), false);
});

test("warnAt=0 disables warning", () => {
  assert.equal(_shouldWarn(99, 100, 0), false);
});

test("default 80% threshold boundary", () => {
  assert.equal(_shouldWarn(79, 100, 0.8), false);
  assert.equal(_shouldWarn(80, 100, 0.8), true);
});

// ── _matches: which caps a spend event / request counts against ──

test("global cap (null dimension) matches everything, including internal overhead", () => {
  assert.equal(_matches({ dimension: null }, { application: "a", internalKind: "classify" }), true);
  assert.equal(_matches({ dimension: null }, {}), true);
});

test("user-dimension cap matches only its userId", () => {
  const cap = { dimension: "user", value: "user_123" };
  assert.equal(_matches(cap, { userId: "user_123" }), true);
  assert.equal(_matches(cap, { userId: "user_999" }), false);
  assert.equal(_matches(cap, { userId: null }), false);
  assert.equal(_matches(cap, {}), false);
});

test("application / provider / department / workflow / model dimensions match their field", () => {
  assert.equal(_matches({ dimension: "application", value: "chat" }, { application: "chat" }), true);
  assert.equal(_matches({ dimension: "provider", value: "openai" }, { provider: "openai" }), true);
  assert.equal(_matches({ dimension: "department", value: "eng" }, { department: "eng" }), true);
  assert.equal(_matches({ dimension: "workflow", value: "summarize" }, { workflow: "summarize" }), true);
  assert.equal(_matches({ dimension: "model", value: "gpt-4o" }, { model: "gpt-4o" }), true);
  assert.equal(_matches({ dimension: "application", value: "chat" }, { application: "other" }), false);
});

test("scoped caps never count Arbr's own internal overhead", () => {
  // A per-user/provider cap is a control over that scope's own traffic; internal
  // classification/eval spend belongs to no customer scope.
  assert.equal(_matches({ dimension: "user", value: "user_123" }, { userId: "user_123", internalKind: "classify" }), false);
  assert.equal(_matches({ dimension: "provider", value: "openai" }, { provider: "openai", internalKind: "eval" }), false);
});

test("unknown dimension never matches", () => {
  assert.equal(_matches({ dimension: "bogus", value: "x" }, { application: "x" }), false);
});
