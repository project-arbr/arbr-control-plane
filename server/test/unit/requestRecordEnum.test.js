"use strict";
// Regression test: handler.js writes routingDecision: "semantic_cache" on every
// semantic-cache hit (server/src/gateway/handler.js:482,511). That value silently
// missed the schema enum, so logger.write's try/catch (logger.js:92-98) swallowed a
// Mongoose validation error on every hit — semantic-cache traffic went unlogged with
// no error surfaced anywhere. This locks the value into the enum going forward.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const RequestRecord = require("../../src/models/RequestRecord");

test("routingDecision accepts every value the gateway actually writes", () => {
  const values = ["passthrough", "explicit", "rule", "auto", "ai", "budget", "cache", "semantic_cache", "fallback", "canary", "external"];
  for (const routingDecision of values) {
    const doc = new RequestRecord({ requestId: `t-${routingDecision}`, model: "m", routingDecision });
    const err = doc.validateSync();
    assert.equal(err, undefined, `"${routingDecision}" should be a valid routingDecision, got: ${err}`);
  }
});

test("routingDecision rejects an unknown value", () => {
  const doc = new RequestRecord({ requestId: "t-bad", model: "m", routingDecision: "not_a_real_value" });
  const err = doc.validateSync();
  assert.ok(err, "an unrecognized routingDecision should fail validation");
});
