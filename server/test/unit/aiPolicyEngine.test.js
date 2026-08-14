"use strict";
// Deterministic evidence-based routing engine (rankCandidates). These exercise the pure ranker directly
// with hand-built model pools — no DB, no LLM — so the policy decisions are asserted in isolation.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { _rankCandidates, _passesGates, _qualityScore } = require("../../src/routing/aiPolicy");

// Helper: a fully-specified (MEASURED) model with an explicit capability vector.
function measured(id, tier, caps, inputPer1M, outputPer1M) {
  return { id, tier, inputPer1M, outputPer1M, capabilities: caps };
}
// Helper: an unknown model with no capability vector and no curated entry → ESTIMATED (deriveCapabilities).
function estimated(id, tier, label, inputPer1M, outputPer1M) {
  return { id, tier, label, inputPer1M, outputPer1M };
}
const flat = (v) => ({ coding:v, reasoning:v, writing:v, analysis:v, language:v, general:v, data:v });

// ── Hard capability gates (#1) ──────────────────────────────────────────────
test("a coding task gates out a cheap low-coding model and picks the capable one", () => {
  const pool = [
    measured("cheap-generalist", "mid", flat(0.4), 0.05, 0.1),   // coding 0.4 < 0.55 floor → gated out
    measured("good-coder", "mid",
      { coding:0.9, reasoning:0.7, writing:0.6, analysis:0.6, language:0.5, general:0.6, data:0.7 }, 1.0, 3.0),
  ];
  const ranked = _rankCandidates("coding", pool, { coding: { tier: "mid" } }, {}, "balanced");
  assert.equal(ranked[0].model, "good-coder", "the capable model wins despite being pricier — cheap one fails the coding gate");
  assert.ok(!ranked.some((c) => c.model === "cheap-generalist"), "the gated-out model is absent from candidates");
});

test("passesGates only enforces dimensions the task strongly needs", () => {
  const coding = { coding:0.95, reasoning:0.5, writing:0.2, analysis:0.2, language:0.0, general:0.1, data:0.3 };
  assert.equal(_passesGates(coding, flat(0.4)), false, "0.4 coding fails a coding-heavy task");
  assert.equal(_passesGates(coding, { ...flat(0.4), coding: 0.6 }), true, "0.6 coding clears the 0.55 floor; low general is not gated");
});

// ── Expected cost prices output, not just input (#3) ────────────────────────
test("cost goal accounts for output price, not input price alone", () => {
  const pool = [
    measured("cheap-input-dear-output", "light", flat(0.8), 0.01, 5.0),
    measured("balanced-price",          "light", flat(0.8), 0.5,  0.5),
  ];
  // Output-heavy traffic: 100 in / 2000 out. The "cheap on input" model is far dearer once output is priced.
  const ranked = _rankCandidates("faq", pool, { faq: { tier: "light" } }, { faq: { avgIn: 100, avgOut: 2000 } }, "cost");
  assert.equal(ranked[0].model, "balanced-price", "output tokens dominate — input-price-only ranking would pick the wrong model");
});

test("cost goal picks the cheapest model that clears the quality bar", () => {
  const pool = [
    measured("a-cheap", "light", flat(0.78), 0.03, 0.06),
    measured("b-dear",  "light", flat(0.82), 0.2,  0.4),
  ];
  const ranked = _rankCandidates("faq", pool, { faq: { tier: "light" } }, {}, "cost");
  assert.equal(ranked[0].model, "a-cheap");
});

// ── Conservative unknowns (#6) ──────────────────────────────────────────────
test("a premium task never takes an ESTIMATED model while a MEASURED one qualifies", () => {
  const pool = [
    measured("measured-reasoner", "premium",
      { coding:0.5, reasoning:0.9, writing:0.5, analysis:0.7, language:0.5, general:0.6, data:0.5 }, 5.0, 15.0),
    estimated("cheap-reasoner", "premium", "reasoning specialist", 0.1, 0.3), // derives reasoning 0.7 → clears gate, but estimated
  ];
  const ranked = _rankCandidates("reasoning", pool, { reasoning: { tier: "premium" } }, {}, "balanced");
  assert.equal(ranked[0].model, "measured-reasoner", "the measured model wins even though the estimated one is far cheaper");
  assert.ok(ranked.every((c) => c.measured), "estimated candidates are excluded from a premium task");
});

// ── Evidence output (#8) ────────────────────────────────────────────────────
test("candidates carry quality, expected cost, confidence and a reason", () => {
  const pool = [
    measured("good-coder", "mid",
      { coding:0.9, reasoning:0.7, writing:0.6, analysis:0.6, language:0.5, general:0.6, data:0.7 }, 1.0, 3.0),
  ];
  const [top] = _rankCandidates("coding", pool, { coding: { tier: "mid" } }, {}, "balanced");
  assert.equal(typeof top.quality, "number");
  assert.ok(top.quality > 0 && top.quality <= 1);
  assert.equal(typeof top.expectedCostPer1k, "number");
  assert.ok(["high", "medium", "low"].includes(top.confidence));
  assert.equal(top.measured, true);
  assert.ok(top.reason.length > 0, "the winning pick carries a human-readable rationale");
});

test("an estimated candidate is flagged low-confidence and needsShadowEval", () => {
  const pool = [estimated("mystery", "light", "general assistant", 0.05, 0.1)];
  const [top] = _rankCandidates("faq", pool, { faq: { tier: "light" } }, {}, "cost");
  assert.equal(top.measured, false);
  assert.equal(top.confidence, "low");
  assert.equal(top.needsShadowEval, true);
});

// ── Determinism (no LLM) ────────────────────────────────────────────────────
test("same inputs produce the same ranking every time", () => {
  const pool = [
    measured("m1", "mid", { coding:0.9, reasoning:0.7, writing:0.6, analysis:0.6, language:0.5, general:0.6, data:0.7 }, 1.0, 3.0),
    measured("m2", "mid", { coding:0.85, reasoning:0.8, writing:0.6, analysis:0.7, language:0.5, general:0.6, data:0.6 }, 1.2, 3.5),
    estimated("m3", "mid", "coding helper", 0.1, 0.2),
  ];
  const a = _rankCandidates("coding", pool, { coding: { tier: "mid" } }, {}, "balanced");
  const b = _rankCandidates("coding", pool, { coding: { tier: "mid" } }, {}, "balanced");
  assert.deepEqual(a, b);
});

test("qualityScore is the task-weighted capability average", () => {
  // Task weights only coding (1.0); everything else 0 → quality equals the model's coding capability.
  const q = _qualityScore({ coding: 1.0, reasoning: 0, writing: 0, analysis: 0, language: 0, general: 0, data: 0 }, flat(0.73));
  assert.equal(q, 0.73);
});
