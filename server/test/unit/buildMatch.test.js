"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildMatch } = require("../../src/analytics/aggregate");

test("empty filter returns empty match object", () => {
  assert.deepEqual(buildMatch({}), {});
  assert.deepEqual(buildMatch(), {});
});

test("from/to builds timestamp range", () => {
  const from = "2024-01-01T00:00:00.000Z";
  const to = "2024-01-31T23:59:59.000Z";
  const m = buildMatch({ from, to });
  assert.ok(m.timestamp, "timestamp key present");
  assert.equal(m.timestamp.$gte.toISOString(), from);
  assert.equal(m.timestamp.$lte.toISOString(), to);
});

test("application filter is included in match", () => {
  const m = buildMatch({ application: "my-app" });
  assert.equal(m.application, "my-app");
  assert.equal(m.timestamp, undefined);
});

test("unknown filter keys are ignored", () => {
  const m = buildMatch({ foo: "bar", baz: 123 });
  assert.equal(m.foo, undefined);
  assert.equal(m.baz, undefined);
});

test("multiple known filters are all merged", () => {
  const m = buildMatch({ application: "app1", provider: "openai", model: "gpt-4o" });
  assert.equal(m.application, "app1");
  assert.equal(m.provider, "openai");
  assert.equal(m.model, "gpt-4o");
});
