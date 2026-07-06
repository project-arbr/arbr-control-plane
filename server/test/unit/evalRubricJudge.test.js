"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  parseRubricVerdict, mapVerdictToCandidate, familyOf, sameFamily, runValidators,
} = require("../../src/eval/rubricJudge");

test("parseRubricVerdict reads strict JSON with scores", () => {
  const v = parseRubricVerdict('noise {"winner":"B","critical_failure":false,"scores":{"correctness":5,"completeness":4,"instruction_following":5,"format":5,"safety":5},"reason":"ok"} trailing');
  assert.equal(v.winner, "B");
  assert.equal(v.criticalFailure, false);
  assert.equal(v.scores.correctness, 5);
  assert.equal(v.reason, "ok");
});

test("parseRubricVerdict clamps out-of-range scores and defaults tie", () => {
  const v = parseRubricVerdict('{"winner":"maybe","scores":{"correctness":9}}');
  assert.equal(v.winner, "tie");
  assert.equal(v.scores.correctness, 5); // clamped to 5
  assert.equal(v.scores.safety, null);   // missing -> null
});

test("parseRubricVerdict returns null on unparseable text", () => {
  assert.equal(parseRubricVerdict("no json here"), null);
});

test("mapVerdictToCandidate handles candidate in slot B", () => {
  const parsed = { winner: "B", criticalFailure: false, scores: {}, reason: "r" };
  assert.equal(mapVerdictToCandidate(parsed, "B").verdict, "better");
  assert.equal(mapVerdictToCandidate({ ...parsed, winner: "A" }, "B").verdict, "worse");
  assert.equal(mapVerdictToCandidate({ ...parsed, winner: "tie" }, "B").verdict, "equal");
});

test("mapVerdictToCandidate handles candidate in slot A (de-biased)", () => {
  const parsed = { winner: "A", criticalFailure: false, scores: {}, reason: "r" };
  assert.equal(mapVerdictToCandidate(parsed, "A").verdict, "better");
  assert.equal(mapVerdictToCandidate({ ...parsed, winner: "B" }, "A").verdict, "worse");
});

test("familyOf / sameFamily group models by vendor", () => {
  assert.equal(familyOf("claude-haiku-4-5"), "anthropic");
  assert.equal(familyOf("gpt-4o-mini"), "openai");
  assert.equal(familyOf("gemini-2.5-flash"), "google");
  assert.equal(sameFamily("claude-opus-4-8", "claude-haiku-4-5"), true);
  assert.equal(sameFamily("claude-haiku-4-5", "gpt-4o-mini"), false);
});

test("runValidators enforces json / contains / label; empty = pass", () => {
  assert.equal(runValidators("{}", [{ type: "json_schema" }]).formatPass, true);
  assert.equal(runValidators("not json", [{ type: "json_schema" }]).formatPass, false);
  assert.equal(runValidators("hello world", [{ type: "contains", value: "world" }]).formatPass, true);
  assert.equal(runValidators("spam", [{ type: "classification_label", labels: ["spam", "ham"] }]).formatPass, true);
  assert.equal(runValidators("maybe", [{ type: "classification_label", labels: ["spam", "ham"] }]).formatPass, false);
  assert.equal(runValidators("anything", []).formatPass, true);
});
