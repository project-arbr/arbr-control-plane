"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { judgeReliability } = require("../../src/eval/judgeReliability");

test("no judged items → all null", () => {
  const r = judgeReliability([{ judgeVerdict: null, abFlipped: true }]);
  assert.equal(r.n, 0);
  assert.equal(r.positionBias, null);
  assert.equal(r.decisiveness, null);
});

test("verdict distribution + decisiveness", () => {
  const r = judgeReliability([
    { judgeVerdict: "better", abFlipped: true },
    { judgeVerdict: "equal", abFlipped: false },
    { judgeVerdict: "worse", abFlipped: true },
    { judgeVerdict: "equal", abFlipped: false },
  ]);
  assert.deepEqual(r.verdictDist, { better: 1, equal: 2, worse: 1 });
  assert.equal(r.decisiveness, 0.5); // 2 of 4 non-equal
});

test("no position bias when win-rate is equal across slots", () => {
  // candidate wins 1/2 in A and 1/2 in B → bias 0
  const r = judgeReliability([
    { judgeVerdict: "better", abFlipped: true },
    { judgeVerdict: "worse", abFlipped: true },
    { judgeVerdict: "better", abFlipped: false },
    { judgeVerdict: "worse", abFlipped: false },
  ]);
  assert.equal(r.positionBias, 0);
});

test("detects a judge that favors slot A", () => {
  // candidate wins every time it's in A, never when in B → bias +1 (favors position A)
  const r = judgeReliability([
    { judgeVerdict: "better", abFlipped: true },
    { judgeVerdict: "better", abFlipped: true },
    { judgeVerdict: "worse", abFlipped: false },
    { judgeVerdict: "worse", abFlipped: false },
  ]);
  assert.equal(r.aWinRate, 1);
  assert.equal(r.bWinRate, 0);
  assert.equal(r.positionBias, 1);
});

test("bias is null when a slot has no items", () => {
  const r = judgeReliability([
    { judgeVerdict: "better", abFlipped: true },
    { judgeVerdict: "worse", abFlipped: true },
  ]);
  assert.equal(r.bWinRate, null);
  assert.equal(r.positionBias, null);
});
