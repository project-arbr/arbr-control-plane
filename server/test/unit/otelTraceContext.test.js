"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseTraceparent } = require("../../src/telemetry/traceContext");

const TRACE = "0af7651916cd43dd8448eb211c80319c";
const SPAN = "b7ad6b7169203331";

test("parses a valid sampled traceparent", () => {
  const r = parseTraceparent(`00-${TRACE}-${SPAN}-01`);
  assert.deepEqual(r, { traceId: TRACE, spanId: SPAN, traceFlags: 1, sampled: true });
});

test("parses an unsampled traceparent", () => {
  const r = parseTraceparent(`00-${TRACE}-${SPAN}-00`);
  assert.equal(r.sampled, false);
});

test("rejects an all-zero trace id", () => {
  assert.equal(parseTraceparent(`00-${"0".repeat(32)}-${SPAN}-01`), null);
});

test("rejects an all-zero span id", () => {
  assert.equal(parseTraceparent(`00-${TRACE}-${"0".repeat(16)}-01`), null);
});

test("rejects the reserved ff version", () => {
  assert.equal(parseTraceparent(`ff-${TRACE}-${SPAN}-01`), null);
});

test("rejects wrong lengths and garbage", () => {
  assert.equal(parseTraceparent(`00-${TRACE}-${SPAN}`), null);        // missing flags
  assert.equal(parseTraceparent(`00-abc-${SPAN}-01`), null);          // short trace id
  assert.equal(parseTraceparent("not-a-traceparent"), null);
  assert.equal(parseTraceparent(""), null);
  assert.equal(parseTraceparent(undefined), null);
  assert.equal(parseTraceparent(null), null);
});

test("is case-insensitive and trims", () => {
  const r = parseTraceparent(`  00-${TRACE.toUpperCase()}-${SPAN.toUpperCase()}-01  `);
  assert.equal(r.traceId, TRACE);
  assert.equal(r.spanId, SPAN);
});
