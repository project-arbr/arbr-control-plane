"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { windowKey, windowStart, _shouldWarn, _matches } = require("../../src/routing/capEngine");

test("windowKey day is UTC calendar day", () => {
  assert.equal(windowKey("day", new Date("2026-07-12T15:00:00Z")), "day:2026-07-12");
});

test("windowKey month is UTC calendar month", () => {
  assert.equal(windowKey("month", new Date("2026-07-12T15:00:00Z")), "month:2026-07");
});

test("windowStart day is ~24h ago", () => {
  const now = Date.parse("2026-07-12T12:00:00Z");
  const start = windowStart("day", now);
  assert.equal(start.getTime(), now - 24 * 60 * 60 * 1000);
});

test("_matches global / application / provider", () => {
  assert.equal(_matches({ dimension: null }, { application: "a", provider: "openai" }), true);
  assert.equal(_matches({ dimension: "application", value: "a" }, { application: "a", provider: "openai" }), true);
  assert.equal(_matches({ dimension: "application", value: "a" }, { application: "b", provider: "openai" }), false);
  assert.equal(_matches({ dimension: "provider", value: "openai" }, { application: "a", provider: "openai" }), true);
  assert.equal(_matches({ dimension: "model", value: "x" }, { application: "a", provider: "openai" }), false);
});

test("shouldWarn still works", () => {
  assert.equal(_shouldWarn(80, 100, 0.8), true);
  assert.equal(_shouldWarn(100, 100, 0.8), false);
});
