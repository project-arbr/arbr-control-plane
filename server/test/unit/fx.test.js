"use strict";
// Unit tests for the live-FX display currency (#1): the pure conversion + rate parse,
// the multi-provider fetch fallback, and the availability/staleness state that keeps a
// failed FX fetch from ever showing a wrong number.
const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { convert, parseRate, fetchRate, state } = require("../../src/currency/fx");

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

test("convert multiplies a USD amount by the rate", () => {
  assert.equal(convert(2, 83.5), 167);
  assert.equal(convert(0, 83.5), 0);
});

test("convert defaults to a 1:1 rate for USD / missing / invalid rate", () => {
  assert.equal(convert(5), 5);
  assert.equal(convert(5, 0), 5, "a zero rate falls back to 1, never zeroing every cost");
  assert.equal(convert(5, -3), 5);
  assert.equal(convert(5, null), 5);
});

test("convert coerces non-numeric input to 0", () => {
  assert.equal(convert("abc", 83.5), 0);
});

test("parseRate pulls the requested currency (case-insensitive) or null", () => {
  const json = { rates: { INR: 83.5, EUR: 0.92 } };
  assert.equal(parseRate(json, "inr"), 83.5);
  assert.equal(parseRate(json, "XYZ"), null);
  assert.equal(parseRate({}, "INR"), null);
  assert.equal(parseRate({ rates: { INR: 0 } }, "INR"), null, "non-positive rate rejected");
});

// The fallback the user asked to harden: if the first provider fails, try the next.
test("fetchRate falls back to the second provider when the first fails", async () => {
  let calls = 0;
  global.fetch = async () => {
    calls++;
    if (calls === 1) throw new Error("network down"); // provider 1 dies
    return { ok: true, json: async () => ({ rates: { INR: 84.2 } }) }; // provider 2 ok
  };
  assert.equal(await fetchRate("INR"), 84.2);
  assert.equal(calls, 2, "second provider was tried");
});

test("fetchRate returns null when every provider fails (caller keeps last/USD)", async () => {
  global.fetch = async () => { throw new Error("down"); };
  assert.equal(await fetchRate("INR"), null);
});

test("fetchRate skips a provider that returns the currency-less/!ok response", async () => {
  let calls = 0;
  global.fetch = async () => {
    calls++;
    if (calls === 1) return { ok: false, json: async () => ({}) };            // http error
    return { ok: true, json: async () => ({ rates: { INR: 83 } }) };
  };
  assert.equal(await fetchRate("INR"), 83);
});

// state() drives the UI's "show USD instead of wrong numbers" behavior.
test("state: USD is always available and never stale", () => {
  const s = state("USD", 1, null);
  assert.equal(s.available, true);
  assert.equal(s.stale, false);
});

test("state: a non-USD currency with no updatedAt is unavailable (UI shows USD)", () => {
  const s = state("INR", 1, null);
  assert.equal(s.available, false, "no rate ever fetched → not available");
});

test("state: a recently fetched non-USD rate is available and fresh", () => {
  const s = state("INR", 83.5, new Date());
  assert.equal(s.available, true);
  assert.equal(s.stale, false);
});

test("state: an old fetched rate is available but stale", () => {
  const old = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000); // 5 days ago
  const s = state("INR", 83.5, old);
  assert.equal(s.available, true);
  assert.equal(s.stale, true);
});
