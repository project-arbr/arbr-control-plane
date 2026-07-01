"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { _shouldWarn } = require("../../src/routing/capEngine");

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
