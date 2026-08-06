"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { perConnCache, runWithConnection } = require("../../src/db/context");
const responseCache = require("../../src/routing/responseCache");

// The per-connection cache is what keeps a TTL cache (Settings 5s, connections 3s creds, ...) from
// serving one tenant's data to another. Fake connections (just a `.name`) drive it.

test("perConnCache gives each connection its own slot", () => {
  const c = perConnCache();
  runWithConnection({ name: "tenant_a" }, () => c.set({ v: 1 }));
  runWithConnection({ name: "tenant_b" }, () => c.set({ v: 2 }));
  runWithConnection({ name: "tenant_a" }, () => assert.deepEqual(c.get(), { v: 1 }));
  runWithConnection({ name: "tenant_b" }, () => assert.deepEqual(c.get(), { v: 2 }));
});

test("invalidate clears only the current connection's slot", () => {
  const c = perConnCache();
  runWithConnection({ name: "tenant_a" }, () => c.set("A"));
  runWithConnection({ name: "tenant_b" }, () => c.set("B"));
  runWithConnection({ name: "tenant_a" }, () => c.invalidate());
  runWithConnection({ name: "tenant_a" }, () => assert.equal(c.get(), undefined));
  runWithConnection({ name: "tenant_b" }, () => assert.equal(c.get(), "B")); // B untouched
});

test("responseCache never serves one tenant's cached response to another", () => {
  const model = "gpt-4o";
  const messages = [{ role: "user", content: "same prompt in both tenants" }];
  runWithConnection({ name: "tenant_a" }, () => responseCache.set(model, messages, "RESPONSE-A"));
  // Identical (model, messages) under a different tenant must miss.
  runWithConnection({ name: "tenant_b" }, () => assert.equal(responseCache.get(model, messages), null));
  // And tenant A still gets its own.
  runWithConnection({ name: "tenant_a" }, () => assert.equal(responseCache.get(model, messages), "RESPONSE-A"));
});
