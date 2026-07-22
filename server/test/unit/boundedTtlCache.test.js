"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createBoundedTtlCache } = require("../../src/utils/boundedTtlCache");

test("hits before the TTL, misses after it", async () => {
  const c = createBoundedTtlCache({ ttlMs: 20, maxEntries: 10 });
  c.set("a", 1);
  assert.equal(c.get("a"), 1);
  await new Promise((r) => setTimeout(r, 35));
  assert.equal(c.get("a"), undefined);
});

test("an expired entry is evicted on read, not merely ignored", async () => {
  const c = createBoundedTtlCache({ ttlMs: 20, maxEntries: 10 });
  c.set("a", 1);
  assert.equal(c.size, 1);
  await new Promise((r) => setTimeout(r, 35));
  c.get("a");
  assert.equal(c.size, 0, "reading an expired key must free it");
});

// The issue: a caller varying the key on every request grew the map forever.
test("size stays capped no matter how many distinct keys arrive", () => {
  const c = createBoundedTtlCache({ ttlMs: 60_000, maxEntries: 50 });
  for (let i = 0; i < 5000; i++) c.set(`app-${i}`, { i });
  assert.equal(c.size, 50);
});

test("eviction at capacity drops the oldest and keeps the newest", () => {
  const c = createBoundedTtlCache({ ttlMs: 60_000, maxEntries: 3 });
  c.set("a", 1);
  c.set("b", 2);
  c.set("c", 3);
  c.set("d", 4); // evicts "a"
  assert.equal(c.get("a"), undefined);
  assert.equal(c.get("d"), 4);
  assert.equal(c.size, 3);
});

test("refreshing an existing key does not evict another", () => {
  const c = createBoundedTtlCache({ ttlMs: 60_000, maxEntries: 2 });
  c.set("a", 1);
  c.set("b", 2);
  c.set("a", 9); // a refresh, not growth
  assert.equal(c.size, 2);
  assert.equal(c.get("a"), 9);
  assert.equal(c.get("b"), 2, "the other key must survive a refresh");
});

// getAppConfig caches `null` for unknown apps; that negative cache is what keeps
// spammed unknown names off the database, so a miss and a cached null must differ.
test("a cached null reads as a hit, not a miss", () => {
  const c = createBoundedTtlCache({ ttlMs: 60_000, maxEntries: 10 });
  c.set("unknown-app", null);
  const hit = c.getEntry("unknown-app");
  assert.notEqual(hit, undefined, "a cached null must still return an entry");
  assert.equal(hit.value, null);
  assert.equal(c.has("unknown-app"), true);
  assert.equal(c.getEntry("never-seen"), undefined);
  assert.equal(c.has("never-seen"), false);
});

test("has() honours the TTL", async () => {
  const c = createBoundedTtlCache({ ttlMs: 20, maxEntries: 10 });
  c.set("k", "v");
  assert.equal(c.has("k"), true);
  await new Promise((r) => setTimeout(r, 35));
  assert.equal(c.has("k"), false);
});

test("clear() empties the cache", () => {
  const c = createBoundedTtlCache({ ttlMs: 60_000, maxEntries: 10 });
  c.set("a", 1);
  c.clear();
  assert.equal(c.size, 0);
});

test("rejects a nonsensical configuration", () => {
  assert.throws(() => createBoundedTtlCache({ ttlMs: 0, maxEntries: 10 }));
  assert.throws(() => createBoundedTtlCache({ ttlMs: 10, maxEntries: 0 }));
});
