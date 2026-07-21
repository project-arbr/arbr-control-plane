"use strict";
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const secretResolver = require("../../src/security/secretResolver");

// A fake SecretProvider — no real GCP calls, no network. Injected directly
// into the live registry array (append/splice), the same array
// secretResolver dispatches through.
const fakeProvider = {
  scheme: "fake",
  matches: (uri) => typeof uri === "string" && uri.startsWith("fake://"),
  resolve: async (uri) => {
    if (uri.includes("fail")) throw new Error("fake provider failure");
    return `resolved:${uri.slice("fake://".length)}`;
  },
};

before(() => { secretResolver.PROVIDERS_REGISTRY.push(fakeProvider); });
after(() => {
  const i = secretResolver.PROVIDERS_REGISTRY.indexOf(fakeProvider);
  if (i >= 0) secretResolver.PROVIDERS_REGISTRY.splice(i, 1);
});

const ENV = "TEST_FAKE_SECRET";
beforeEach(async () => {
  // Clear any cache entry from a prior test by resolving a literal.
  await secretResolver.resolveOne(ENV, "reset-to-literal");
});

test("a literal value passes through unchanged and is never marked as a secret ref", async () => {
  const value = await secretResolver.resolveOne(ENV, "sk-literal-value");
  assert.equal(value, "sk-literal-value");
  assert.equal(secretResolver.getResolved(ENV), undefined); // literal never cached
  assert.equal(secretResolver.wasSecretRef(ENV), false);
});

test("a matching ref resolves and caches the resolved value", async () => {
  const value = await secretResolver.resolveOne(ENV, "fake://my-secret");
  assert.equal(value, "resolved:my-secret");
  assert.equal(secretResolver.getResolved(ENV), "resolved:my-secret");
  assert.equal(secretResolver.wasSecretRef(ENV), true);
});

test("resolveOne throws for an unrecognized scheme", async () => {
  await assert.rejects(
    () => secretResolver.resolveOne(ENV, "unregistered-scheme://x"),
    /no provider registered/
  );
});

test("refreshAll collects a failing resolve instead of throwing", async () => {
  process.env[ENV] = "fake://please-fail";
  const { resolved, failures } = await secretResolver.refreshAll([ENV]);
  delete process.env[ENV];
  assert.deepEqual(resolved, []);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].name, ENV);
  assert.match(failures[0].error, /fake provider failure/);
});

test("resolvedOrLiteral: a plain literal env var passes through unchanged", () => {
  process.env[ENV] = "sk-a-plain-literal-key";
  assert.equal(secretResolver.resolvedOrLiteral(ENV), "sk-a-plain-literal-key");
  delete process.env[ENV];
});

test("resolvedOrLiteral: returns the resolved value once a ref has been resolved", async () => {
  process.env[ENV] = "fake://real-value";
  await secretResolver.refreshAll([ENV]);
  assert.equal(secretResolver.resolvedOrLiteral(ENV), "resolved:real-value");
  delete process.env[ENV];
});

test("resolvedOrLiteral: an UNRESOLVED ref never falls through as if it were the literal credential", () => {
  // The exact gap a manual boot smoke test caught: without this, a
  // gcp-sm://... string that failed to resolve (or was never refreshed)
  // would be silently accepted as a usable credential value.
  process.env[ENV] = "fake://never-refreshed";
  assert.equal(secretResolver.resolvedOrLiteral(ENV), undefined);
  delete process.env[ENV];
});

test("resolvedOrLiteral: unset env var returns undefined", () => {
  delete process.env[ENV];
  assert.equal(secretResolver.resolvedOrLiteral(ENV), undefined);
});

test("refreshAll resolves a successful ref and overwrites the cache on a subsequent refresh", async () => {
  process.env[ENV] = "fake://first-value";
  let result = await secretResolver.refreshAll([ENV]);
  assert.deepEqual(result.resolved, [ENV]);
  assert.equal(secretResolver.getResolved(ENV), "resolved:first-value");

  process.env[ENV] = "fake://second-value";
  result = await secretResolver.refreshAll([ENV]);
  assert.deepEqual(result.resolved, [ENV]);
  assert.equal(secretResolver.getResolved(ENV), "resolved:second-value");

  delete process.env[ENV];
});

test("refreshAll skips an unset env var without error", async () => {
  delete process.env[ENV];
  const { resolved, failures } = await secretResolver.refreshAll([ENV]);
  assert.deepEqual(resolved, []);
  assert.deepEqual(failures, []);
});

test("assertResolvedOrThrow: production + failures -> throws with an actionable message", () => {
  assert.throws(
    () => secretResolver.assertResolvedOrThrow([{ name: "X", error: "boom" }], true),
    /Refusing to start.*X: boom/s
  );
});

test("assertResolvedOrThrow: production + no failures -> does not throw", () => {
  assert.doesNotThrow(() => secretResolver.assertResolvedOrThrow([], true));
});

test("assertResolvedOrThrow: non-production + failures -> warns, does not throw", () => {
  assert.doesNotThrow(() => secretResolver.assertResolvedOrThrow([{ name: "X", error: "boom" }], false));
});
