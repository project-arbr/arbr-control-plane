"use strict";
// Pure-logic coverage for the demo-fixture synthesizer (F-06). synthesizeRun() itself writes
// to Mongo, so it's covered in server/test/integration/demoFixture.test.js — this file covers
// only syntheticEntries(), the pure generator, composed with the SAME real, exported
// aggregate()/evaluateRun() production uses (no DB needed for either).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { syntheticEntries } = require("../../src/eval/demoFixture");
const { aggregate } = require("../../src/eval/replay");
const { targetCountForRisk, defaultThresholds, evaluateRun } = require("../../src/eval/thresholds");

test("syntheticEntries is deterministic: same count/outcome produces byte-identical output", () => {
  const a = syntheticEntries(50, "pass");
  const b = syntheticEntries(50, "pass");
  assert.deepEqual(a, b);
});

test("pass and fail outcomes diverge (not the same sequence reused)", () => {
  const pass = syntheticEntries(50, "pass");
  const fail = syntheticEntries(50, "fail");
  assert.notDeepEqual(pass, fail);
});

for (const risk of ["low", "medium", "high"]) {
  test(`outcome:"pass" genuinely clears every ${risk}-risk threshold via the real evaluateRun gate`, () => {
    const count = targetCountForRisk(risk);
    const entries = syntheticEntries(count, "pass");
    const summary = aggregate(entries);
    const { passed, failures } = evaluateRun(summary, defaultThresholds(risk));
    assert.equal(passed, true, `expected a pass, got failures: ${failures.join("; ")}`);
    assert.deepEqual(failures, []);
  });

  test(`outcome:"fail" genuinely breaches the real evaluateRun gate for ${risk} risk, with non-empty reasons`, () => {
    const count = targetCountForRisk(risk);
    const entries = syntheticEntries(count, "fail");
    const summary = aggregate(entries);
    const { passed, failures } = evaluateRun(summary, defaultThresholds(risk));
    assert.equal(passed, false);
    assert.ok(failures.length > 0);
  });
}

test("every generated entry has the exact shape aggregate() expects", () => {
  const entries = syntheticEntries(10, "pass");
  for (const e of entries) {
    assert.equal(typeof e.verdict, "string");
    assert.equal(typeof e.criticalFailure, "boolean");
    assert.equal(typeof e.formatPass, "boolean");
    assert.equal(typeof e.candidateCost, "number");
    assert.equal(typeof e.candidateLatencyMs, "number");
    assert.equal(typeof e.productionCost, "number");
    assert.equal(typeof e.productionLatencyMs, "number");
    assert.equal(e.errored, false);
  }
});
