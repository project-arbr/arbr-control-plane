"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { aggregate, estimateRunCost } = require("../../src/eval/replay");

test("aggregate computes rates, cost saving, and latency delta", () => {
  const entries = [
    { verdict: "better", criticalFailure: false, formatPass: true, candidateCost: 1, candidateLatencyMs: 80, productionCost: 4, productionLatencyMs: 100, errored: false },
    { verdict: "equal", criticalFailure: false, formatPass: true, candidateCost: 1, candidateLatencyMs: 90, productionCost: 4, productionLatencyMs: 100, errored: false },
    { verdict: "worse", criticalFailure: true, formatPass: false, candidateCost: 1, candidateLatencyMs: 120, productionCost: 4, productionLatencyMs: 100, errored: false },
    { errored: true },
  ];
  const s = aggregate(entries);
  assert.equal(s.total, 4);
  assert.equal(s.judged, 3);
  assert.equal(s.candidateWorse, 1);
  assert.ok(Math.abs(s.worseRate - 1 / 3) < 1e-9);
  assert.ok(Math.abs(s.criticalFailRate - 1 / 3) < 1e-9);
  assert.ok(Math.abs(s.formatPassRate - 2 / 3) < 1e-9);
  // prod 12 vs candidate 3 over the 3 ok items -> 75% saving
  assert.ok(Math.abs(s.costSavingPct - 0.75) < 1e-9);
  assert.equal(s.errored, 1);
});

test("aggregate is safe on an empty set", () => {
  const s = aggregate([]);
  assert.equal(s.total, 0);
  assert.equal(s.worseRate, 0);
  assert.equal(s.costSavingPct, 0);
});

test("estimateRunCost scales production cost by candidate + judge price ratio", () => {
  const getModel = (id) => ({
    "base": { inputPer1M: 10, outputPer1M: 30 },   // total 40
    "cand": { inputPer1M: 1, outputPer1M: 3 },      // total 4  -> 0.1x
    "judge": { inputPer1M: 2, outputPer1M: 6 },     // total 8  -> 0.2x
  })[id] || null;
  const items = [{ productionCost: 1 }, { productionCost: 1 }]; // prodSum = 2
  const est = estimateRunCost(items, "base", "cand", "judge", getModel);
  // 2 * (0.1 + 0.2) = 0.6
  assert.ok(Math.abs(est - 0.6) < 1e-9);
});

test("estimateRunCost falls back when rates are unknown", () => {
  const est = estimateRunCost([{ productionCost: 0 }, { productionCost: 0 }], "x", "y", null, () => null);
  assert.ok(Math.abs(est - 0.04) < 1e-9); // 2 items * 0.02
});
