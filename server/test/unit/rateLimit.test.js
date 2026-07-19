"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  windowStart, isOverLimit, _overRpmLimitMemory, _resetMemory, WINDOW_MS,
} = require("../../src/routing/rateLimit");

test("windowStart floors to minute boundary", () => {
  const t = Date.parse("2026-07-12T12:34:56.789Z");
  const ws = windowStart(t);
  assert.equal(ws % WINDOW_MS, 0);
  assert.ok(ws <= t);
  assert.ok(t - ws < WINDOW_MS);
});

test("isOverLimit is exclusive of the rpm cap (count > rpm)", () => {
  assert.equal(isOverLimit(10, 10), false);
  assert.equal(isOverLimit(11, 10), true);
  assert.equal(isOverLimit(1, 0), false);
});

test("memory fallback enforces rpm within a window", () => {
  _resetMemory();
  const now = windowStart(Date.now());
  assert.equal(_overRpmLimitMemory("k", 3, now), false);
  assert.equal(_overRpmLimitMemory("k", 3, now), false);
  assert.equal(_overRpmLimitMemory("k", 3, now), false);
  assert.equal(_overRpmLimitMemory("k", 3, now), true); // 4th request over
});

test("memory fallback resets on new window", () => {
  _resetMemory();
  const now = windowStart(Date.now());
  for (let i = 0; i < 3; i++) _overRpmLimitMemory("k2", 3, now);
  assert.equal(_overRpmLimitMemory("k2", 3, now), true);
  assert.equal(_overRpmLimitMemory("k2", 3, now + WINDOW_MS), false);
});
