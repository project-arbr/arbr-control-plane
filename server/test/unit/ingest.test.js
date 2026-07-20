"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { namespacedRequestId, validateEvent, MAX_BATCH_SIZE } = require("../../src/gateway/ingest");

test("namespacedRequestId scopes the caller's id per API key", () => {
  assert.equal(namespacedRequestId("key1", "abc"), "ingest:key1:abc");
});

test("namespacedRequestId keeps two keys from colliding on the same caller id", () => {
  assert.notEqual(namespacedRequestId("key1", "abc"), namespacedRequestId("key2", "abc"));
});

test("MAX_BATCH_SIZE is a sane positive cap", () => {
  assert.equal(MAX_BATCH_SIZE, 500);
});

test("validateEvent requires an object", () => {
  assert.match(validateEvent(null), /object/);
  assert.match(validateEvent("nope"), /object/);
});

test("validateEvent requires a string requestId", () => {
  assert.match(validateEvent({ model: "gpt-4o-mini" }), /requestId/);
  assert.match(validateEvent({ requestId: 123, model: "gpt-4o-mini" }), /requestId/);
});

test("validateEvent requires a string model", () => {
  assert.match(validateEvent({ requestId: "a" }), /model/);
  assert.match(validateEvent({ requestId: "a", model: 42 }), /model/);
});

test("validateEvent accepts success/failure/blocked and rejects other statuses", () => {
  for (const status of ["success", "failure", "blocked"]) {
    assert.equal(validateEvent({ requestId: "a", model: "m", status }), null);
  }
  assert.match(validateEvent({ requestId: "a", model: "m", status: "pending" }), /status/);
});

test("validateEvent accepts a minimal well-formed event", () => {
  assert.equal(validateEvent({ requestId: "a", model: "gpt-4o-mini" }), null);
});
