"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  riskForTier, targetCountForRisk, defaultThresholds, evaluateRun, gateAccept,
} = require("../../src/eval/thresholds");

test("riskForTier maps task tiers to risk bands", () => {
  assert.equal(riskForTier("light"), "low");
  assert.equal(riskForTier("mid"), "medium");
  assert.equal(riskForTier("premium"), "high");
  assert.equal(riskForTier(undefined), "medium");
});

test("targetCountForRisk scales sample size with risk", () => {
  assert.equal(targetCountForRisk("low"), 200);
  assert.equal(targetCountForRisk("high"), 500);
});

test("evaluateRun passes a clean summary", () => {
  const t = defaultThresholds("low");
  const summary = { judged: 250, worseRate: 0.02, criticalFailRate: 0, formatPassRate: 0.99, costSavingPct: 0.6, avgLatencyDeltaPct: -0.2 };
  const { passed, failures } = evaluateRun(summary, t);
  assert.equal(passed, true);
  assert.deepEqual(failures, []);
});

test("evaluateRun fails on too few items and high worse-rate", () => {
  const t = defaultThresholds("low");
  const summary = { judged: 10, worseRate: 0.2, criticalFailRate: 0, formatPassRate: 0.99, costSavingPct: 0.6, avgLatencyDeltaPct: 0 };
  const { passed, failures } = evaluateRun(summary, t);
  assert.equal(passed, false);
  assert.ok(failures.some((f) => f.includes("items")));
  assert.ok(failures.some((f) => f.includes("worse-rate")));
});

test("evaluateRun fails when cost saving is below the floor", () => {
  const t = defaultThresholds("low");
  const summary = { judged: 250, worseRate: 0, criticalFailRate: 0, formatPassRate: 1, costSavingPct: 0.10, avgLatencyDeltaPct: 0 };
  const { passed, failures } = evaluateRun(summary, t);
  assert.equal(passed, false);
  assert.ok(failures.some((f) => f.includes("cost saving")));
});

test("high-risk forbids any critical failure", () => {
  const t = defaultThresholds("high");
  const summary = { judged: 500, worseRate: 0, criticalFailRate: 0.001, formatPassRate: 1, costSavingPct: 0.5, avgLatencyDeltaPct: 0 };
  assert.equal(evaluateRun(summary, t).passed, false);
});

test("gateAccept allows a passed recommendation", () => {
  assert.deepEqual(gateAccept({ evalStatus: "passed" }, null), { allowed: true, status: "passed" });
});

test("gateAccept blocks an un-evaluated recommendation", () => {
  const g = gateAccept({ evalStatus: "not_started" }, null);
  assert.equal(g.allowed, false);
  assert.ok(/not passed evaluation/.test(g.reason));
});

test("gateAccept allows a valid override", () => {
  const g = gateAccept({ evalStatus: "failed" }, { reason: "urgent", approver: "prasanna" });
  assert.equal(g.allowed, true);
  assert.equal(g.status, "overridden");
});

test("gateAccept rejects an expired override", () => {
  const now = 1_000_000;
  const g = gateAccept({ evalStatus: "failed" }, { reason: "x", approver: "y", expiresAt: new Date(now - 1).toISOString() }, now);
  assert.equal(g.allowed, false);
  assert.ok(/expired/.test(g.reason));
});

test("gateAccept rejects an override missing approver", () => {
  assert.equal(gateAccept({ evalStatus: "failed" }, { reason: "x" }).allowed, false);
});
