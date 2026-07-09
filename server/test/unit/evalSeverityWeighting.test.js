"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { aggregate } = require("../../src/eval/replay");

const item = (verdict, severity) => ({
  verdict, severity, errored: false, criticalFailure: false, formatPass: true,
  candidateCost: 0, candidateLatencyMs: 0, productionCost: 0, productionLatencyMs: 0,
});

test("uniform severity → weighted worse-rate equals the raw rate", () => {
  const s = aggregate([item("worse", "normal"), item("better", "normal"), item("better", "normal"), item("better", "normal")]);
  assert.equal(s.worseRateRaw, 0.25);
  assert.equal(s.worseRate, 0.25); // weighted == raw when all normal
});

test("a critical miss outweighs trivial passes", () => {
  // 1 critical worse (w=3) + 3 trivial better (w=0.3 each = 0.9). weighted = 3 / (3+0.9) ≈ 0.769
  const s = aggregate([item("worse", "critical"), item("better", "trivial"), item("better", "trivial"), item("better", "trivial")]);
  assert.equal(s.worseRateRaw, 0.25);          // 1 of 4 raw
  assert.ok(s.worseRate > 0.75 && s.worseRate < 0.78); // weighted heavily by the critical miss
});

test("a trivial miss barely moves the weighted rate", () => {
  // 1 trivial worse (w=0.3) + 3 critical better (w=9). weighted = 0.3 / 9.3 ≈ 0.032
  const s = aggregate([item("worse", "trivial"), item("better", "critical"), item("better", "critical"), item("better", "critical")]);
  assert.equal(s.worseRateRaw, 0.25);
  assert.ok(s.worseRate < 0.05);
});

test("severity breakdown counts judged + worse per band", () => {
  const s = aggregate([item("worse", "critical"), item("better", "critical"), item("equal", "normal")]);
  assert.deepEqual(s.severityBreakdown.critical, { judged: 2, worse: 1 });
  assert.deepEqual(s.severityBreakdown.normal, { judged: 1, worse: 0 });
});
