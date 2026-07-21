"use strict";
// The zero-config regression guard. With ARBR_OTEL_ENABLED unset, requiring the
// telemetry module must NOT load the OpenTelemetry SDK, and emit() must be a safe
// no-op. This keeps the "boots with no config, costs nothing" invariant honest.
// (node --test isolates each test file in its own process, so another file
// enabling tracing can't pollute this one's require.cache.)
const { test } = require("node:test");
const assert = require("node:assert/strict");

delete process.env.ARBR_OTEL_ENABLED;

const telemetry = require("../../src/telemetry");

test("disabled by default", () => {
  telemetry.init();
  assert.equal(telemetry.isEnabled(), false);
});

test("the OpenTelemetry SDK is never loaded when disabled", () => {
  const loaded = Object.keys(require.cache).filter((k) => k.includes("@opentelemetry"));
  assert.deepEqual(loaded, [], "no @opentelemetry/* module should be in the require cache");
});

test("emit is a no-op that never throws when disabled", () => {
  assert.doesNotThrow(() => telemetry.emit({ requestId: "x", model: "m", status: "success" }, {}));
  assert.doesNotThrow(() => telemetry.emit({}, {}));
});

test("forceFlush and shutdown are safe no-ops when disabled", async () => {
  await telemetry.forceFlush();
  await telemetry.shutdown();
});
