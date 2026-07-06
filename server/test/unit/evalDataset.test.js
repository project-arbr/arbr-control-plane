"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  buildScopeQuery, isEligible, promptHashOf, dedupeByPromptHash, stratifiedSample, stratumKey, projectText, inferValidators,
} = require("../../src/eval/dataset");

test("inferValidators requires JSON when baseline outputs are all JSON", () => {
  const v = inferValidators(['{"a":1}', '{"b":2}', '{"c":3}', '{"d":4}', '{"e":5}']);
  assert.deepEqual(v, [{ type: "json_schema" }]);
});

test("inferValidators infers a label set for a small closed set of short strings", () => {
  const v = inferValidators(["billing", "technical", "billing", "account", "technical", "feedback"]);
  assert.equal(v[0].type, "classification_label");
  assert.deepEqual(new Set(v[0].labels), new Set(["billing", "technical", "account", "feedback"]));
});

test("inferValidators attaches nothing for free-form text or too-few samples", () => {
  assert.deepEqual(inferValidators(["a long free-form sentence that is clearly prose and not a label at all", "another distinct long free-form paragraph of text here", "yet another unique long sentence", "and one more different long sentence", "plus a fifth unique long sentence"]), []);
  assert.deepEqual(inferValidators(["billing", "technical"]), []); // < 5 samples
});

test("buildScopeQuery restricts to success + non-cache + scope", () => {
  const q = buildScopeQuery({ taskType: "classification", currentModel: "gpt-4o" }, new Date(0));
  assert.equal(q.status, "success");
  assert.deepEqual(q.cacheHit, { $ne: true });
  assert.equal(q.taskType, "classification");
  assert.equal(q.model, "gpt-4o");
  assert.ok(q.timestamp.$gte instanceof Date);
});

test("isEligible requires single-shot with prompt + response", () => {
  assert.equal(isEligible({ responseText: "ok", messages: [{ role: "user", content: "hi" }] }), true);
  assert.equal(isEligible({ responseText: "", messages: [{ role: "user", content: "hi" }] }), false);
  assert.equal(isEligible({ responseText: "ok", messages: null }), false);
  // multi-turn (has assistant turn) is not single-shot
  assert.equal(isEligible({ responseText: "ok", messages: [{ role: "assistant", content: "x" }, { role: "user", content: "y" }] }), false);
});

test("dedupeByPromptHash keeps one record per identical prompt", () => {
  const a = { messages: [{ role: "user", content: "same" }] };
  const b = { messages: [{ role: "user", content: "same" }] };
  const c = { messages: [{ role: "user", content: "different" }] };
  assert.equal(dedupeByPromptHash([a, b, c]).length, 2);
});

test("promptHashOf is stable and content-sensitive", () => {
  const m1 = [{ role: "user", content: "hi" }];
  assert.equal(promptHashOf(m1), promptHashOf([{ role: "user", content: "hi" }]));
  assert.notEqual(promptHashOf(m1), promptHashOf([{ role: "user", content: "bye" }]));
});

test("stratifiedSample balances across strata and respects target", () => {
  const recs = [];
  for (let i = 0; i < 10; i++) recs.push({ workflow: "a", difficulty: "light" });
  for (let i = 0; i < 10; i++) recs.push({ workflow: "b", difficulty: "mid" });
  const out = stratifiedSample(recs, 6, stratumKey);
  assert.equal(out.length, 6);
  const a = out.filter((r) => r.workflow === "a").length;
  const b = out.filter((r) => r.workflow === "b").length;
  assert.equal(a, 3); // round-robin => even split
  assert.equal(b, 3);
});

test("stratifiedSample returns all when under target", () => {
  const recs = [{ workflow: "a" }, { workflow: "b" }];
  assert.equal(stratifiedSample(recs, 10, stratumKey).length, 2);
});

test("projectText honors metadata_only (no text) and masked modes", () => {
  const rec = { messages: [{ role: "user", content: "email me at a@b.com" }], responseText: "call 415-555-1212" };
  const meta = projectText(rec, "metadata_only", false, []);
  assert.equal(meta.messages, null);
  assert.equal(meta.productionResponse, null);

  const masked = projectText(rec, "masked", false, []);
  assert.ok(masked.messages); // present
  assert.ok(!JSON.stringify(masked.messages).includes("a@b.com")); // email masked
});
