"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { computeReadiness } = require("../../src/health/readiness");

test("ready when not shutting down and Mongo is connected (readyState 1)", () => {
  assert.deepEqual(
    computeReadiness({ isShuttingDown: false, mongoReadyState: 1 }),
    { ready: true, reason: null }
  );
});

test("not ready while shutting down, even if Mongo is connected", () => {
  assert.deepEqual(
    computeReadiness({ isShuttingDown: true, mongoReadyState: 1 }),
    { ready: false, reason: "shutting_down" }
  );
});

test("not ready when Mongo is disconnected (readyState 0)", () => {
  assert.deepEqual(
    computeReadiness({ isShuttingDown: false, mongoReadyState: 0 }),
    { ready: false, reason: "mongo_disconnected" }
  );
});

test("not ready when Mongo is still connecting (readyState 2)", () => {
  assert.deepEqual(
    computeReadiness({ isShuttingDown: false, mongoReadyState: 2 }),
    { ready: false, reason: "mongo_disconnected" }
  );
});

test("not ready when Mongo is disconnecting (readyState 3)", () => {
  assert.deepEqual(
    computeReadiness({ isShuttingDown: false, mongoReadyState: 3 }),
    { ready: false, reason: "mongo_disconnected" }
  );
});

test("shutting_down takes precedence over a Mongo-disconnected reason", () => {
  // Order matters: during shutdown, Mongo is disconnected LAST (index.js's
  // shutdown() drains, then disconnects Mongo) — the reason reported should
  // be the actual cause (draining), not the Mongo state that follows from it.
  assert.deepEqual(
    computeReadiness({ isShuttingDown: true, mongoReadyState: 0 }),
    { ready: false, reason: "shutting_down" }
  );
});
