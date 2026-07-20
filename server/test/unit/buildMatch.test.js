"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildMatch } = require("../../src/analytics/aggregate");

// Default-deny: an empty filter is NOT an empty match. Every view that doesn't opt in
// gets customer traffic only, so Arbr's own internal calls can never be attributed to a
// customer application by a query that forgot to exclude them.
test("empty filter excludes internal records by default", () => {
  assert.deepEqual(buildMatch({}), { internalKind: null });
  assert.deepEqual(buildMatch(), { internalKind: null });
});

test("internalScope selects the internal/customer split", () => {
  assert.deepEqual(buildMatch({ internalScope: "customer" }), { internalKind: null });
  assert.deepEqual(buildMatch({ internalScope: "internal" }), { internalKind: { $ne: null } });
  // "all" imposes no constraint — headline totals include real overhead.
  assert.deepEqual(buildMatch({ internalScope: "all" }), {});
});

test("internalScope composes with dimension filters", () => {
  assert.deepEqual(
    buildMatch({ application: "checkout", internalScope: "all" }),
    { application: "checkout" }
  );
  assert.deepEqual(
    buildMatch({ application: "checkout" }),
    { application: "checkout", internalKind: null }
  );
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
