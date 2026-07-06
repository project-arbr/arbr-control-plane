"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { bucket, matchExperiment } = require("../../src/routing/canaryEngine");
const { evaluateGuardrails } = require("../../src/routing/canaryMonitor");

test("bucket is deterministic and in [0,100)", () => {
  const a = bucket("app", "wf", "user-1", "exp-1");
  const b = bucket("app", "wf", "user-1", "exp-1");
  assert.equal(a, b);
  assert.ok(a >= 0 && a < 100);
});

test("bucket varies by user and by experiment", () => {
  const base = bucket("app", "wf", "user-1", "exp-1");
  assert.notEqual(base, bucket("app", "wf", "user-2", "exp-1")); // different user
  assert.notEqual(base, bucket("app", "wf", "user-1", "exp-2")); // different experiment
});

test("bucket distributes roughly uniformly (in-canary count near rolloutPct)", () => {
  let inCanary = 0;
  for (let i = 0; i < 1000; i++) if (bucket("app", "wf", `u${i}`, "exp") < 10) inCanary++;
  assert.ok(inCanary > 60 && inCanary < 140, `expected ~100, got ${inCanary}`); // 10% of 1000
});

test("matchExperiment requires active status and matching baseline", () => {
  const exp = { status: "active", baselineModel: "gpt-4o", scope: { application: "a", taskType: "classification" } };
  assert.equal(matchExperiment(exp, { application: "a", taskType: "classification", servedModel: "gpt-4o" }), true);
  assert.equal(matchExperiment(exp, { application: "a", taskType: "classification", servedModel: "gpt-4o-mini" }), false); // baseline mismatch
  assert.equal(matchExperiment(exp, { application: "b", taskType: "classification", servedModel: "gpt-4o" }), false); // app mismatch
  assert.equal(matchExperiment({ ...exp, status: "paused" }, { application: "a", taskType: "classification", servedModel: "gpt-4o" }), false);
});

test("matchExperiment treats null scope fields as any", () => {
  const exp = { status: "active", baselineModel: "gpt-4o", scope: {} };
  assert.equal(matchExperiment(exp, { application: "anything", workflow: "x", taskType: "y", servedModel: "gpt-4o" }), true);
});

test("evaluateGuardrails skips when sample is too small", () => {
  const v = evaluateGuardrails({ candTotal: 3, candErrorRate: 1 }, { maxErrorRateIncrease: 0.02 }, 20);
  assert.equal(v.breached, false);
  assert.equal(v.insufficient, true);
});

test("evaluateGuardrails breaches on error-rate increase", () => {
  const v = evaluateGuardrails({ candTotal: 100, candErrorRate: 0.10, baseErrorRate: 0.02 }, { maxErrorRateIncrease: 0.02 }, 20);
  assert.equal(v.breached, true);
  assert.ok(v.reasons[0].includes("error rate"));
});

test("evaluateGuardrails breaches on latency, cost-saving, and worse-rate", () => {
  const g = { maxLatencyRegressionPct: 0.25, minCostSavingPct: 0.10, maxWorseRate: 0.10 };
  assert.equal(evaluateGuardrails({ candTotal: 50, latencyRegressionPct: 0.5 }, g, 20).breached, true);
  assert.equal(evaluateGuardrails({ candTotal: 50, costSavingPct: 0.02 }, g, 20).breached, true);
  assert.equal(evaluateGuardrails({ candTotal: 50, worseRate: 0.3 }, g, 20).breached, true);
});

test("evaluateGuardrails passes a healthy candidate", () => {
  const m = { candTotal: 100, candErrorRate: 0.01, baseErrorRate: 0.02, latencyRegressionPct: -0.1, costSavingPct: 0.6, worseRate: 0.01 };
  const g = { maxErrorRateIncrease: 0.02, maxLatencyRegressionPct: 0.25, minCostSavingPct: 0.10, maxWorseRate: 0.10 };
  assert.equal(evaluateGuardrails(m, g, 20).breached, false);
});
