"use strict";
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { config } = require("../../src/config");
const pool = require("../../src/gateway/replicaPool");

// eff as connections.effective() shapes it: custom providers carry baseURL, pool and draining.
function eff(overrides = {}) {
  const custom = (pool_, extra = {}) => ({ baseURL: "http://x/v1", pool: pool_, draining: false, ...extra });
  return {
    providers: {
      openai: { credential: {} },
      a: custom("qwen"),
      b: custom("qwen"),
      c: custom("qwen"),
      solo: custom(null),
      other: custom("glm"),
      ...overrides,
    },
  };
}

beforeEach(() => pool._reset());

test("a provider without a pool is its own only member", () => {
  assert.deepEqual(pool.members("solo", eff()), ["solo"]);
  assert.deepEqual(pool.order("solo", eff()), ["solo"]);
  assert.deepEqual(pool.order("openai", eff()), ["openai"]);
});

test("members are every live custom provider with the same pool name", () => {
  assert.deepEqual(pool.members("b", eff()), ["a", "b", "c"]);
  assert.deepEqual(pool.members("other", eff()), ["other"]);
});

test("idle members rotate so load spreads evenly", () => {
  const firsts = [];
  for (let i = 0; i < 6; i++) firsts.push(pool.order("a", eff())[0]);
  assert.deepEqual(firsts.sort(), ["a", "a", "b", "b", "c", "c"]);
});

test("the member with the fewest requests in flight goes first", () => {
  pool.acquire("a"); pool.acquire("a"); pool.acquire("b");
  assert.equal(pool.order("a", eff())[0], "c");
  pool.release("a"); pool.release("a");
  assert.notEqual(pool.order("a", eff())[0], "b", "b still has one in flight; a and c have none");
});

test("a failed member cools down and goes last, then returns after the cooldown", () => {
  const now = 1_000_000;
  pool.reportFailure("a", now);
  const during = pool.order("a", eff(), now + 1);
  assert.equal(during[during.length - 1], "a");
  assert.equal(during.length, 3, "a cooling member is still tried as a last resort");
  const snap = pool.snapshot(eff(), now + config.replicaCooldownMs + 1).find((r) => r.provider === "a");
  assert.equal(snap.healthy, true);
});

test("success clears a member's failure streak", () => {
  pool.reportFailure("b", 5);
  pool.reportSuccess("b");
  const snap = pool.snapshot(eff(), 6).find((r) => r.provider === "b");
  assert.equal(snap.consecutiveFailures, 0);
  assert.equal(snap.healthy, true);
  assert.equal(snap.served, 1);
  assert.equal(snap.failed, 1);
});

test("a draining member is never tried; all draining leaves nothing to try", () => {
  const e = eff({ b: { baseURL: "http://x/v1", pool: "qwen", draining: true } });
  for (let i = 0; i < 5; i++) assert.equal(pool.order("a", e).includes("b"), false);
  const all = eff({
    a: { baseURL: "http://x/v1", pool: "qwen", draining: true },
    b: { baseURL: "http://x/v1", pool: "qwen", draining: true },
    c: { baseURL: "http://x/v1", pool: "qwen", draining: true },
  });
  assert.deepEqual(pool.order("a", all), []);
});

test("in-flight never goes negative", () => {
  pool.release("a");
  assert.equal(pool.snapshot(eff()).find((r) => r.provider === "a").inFlight, 0);
});

test("only server-side statuses are retried on another member", () => {
  for (const s of [429, 500, 502, 503, 504]) assert.equal(pool.retryableStatus(s), true, String(s));
  for (const s of [200, 400, 401, 404, 422]) assert.equal(pool.retryableStatus(s), false, String(s));
});

test("snapshot lists pooled providers only", () => {
  assert.deepEqual(pool.snapshot(eff()).map((r) => r.provider), ["a", "b", "c", "other"]);
});

test("reachable: an open port is reachable, a black-holed one times out, a recent success skips the check", async () => {
  const net = require("net");
  const srv = net.createServer((s) => s.destroy());
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  assert.equal(await pool.reachable("p-open", `http://127.0.0.1:${port}/v1`), true);
  await new Promise((r) => srv.close(r));
  assert.equal(await pool.reachable("p-closed", `http://127.0.0.1:${port}/v1`), false, "refused");
  // 10.255.255.1 is unroutable: packets are dropped, so only the timeout can answer.
  const t0 = Date.now();
  assert.equal(await pool.reachable("p-silent", "http://10.255.255.1:8000/v1"), false);
  assert.ok(Date.now() - t0 < config.replicaConnectTimeoutMs + 1500);
  pool.reportSuccess("p-silent");
  assert.equal(await pool.reachable("p-silent", "http://10.255.255.1:8000/v1"), true, "answered just now");
});
