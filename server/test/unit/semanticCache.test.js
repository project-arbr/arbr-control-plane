"use strict";
const { test } = require("node:test");
const assert = require("assert/strict");
const { cosineSimilarity, _textFromMessages, clear, size } = require("../../src/routing/semanticCache");

// ── cosineSimilarity ─────────────────────────────────────────────────────────

test("cosineSimilarity: identical vectors → 1.0", () => {
  const v = [1, 0, 0, 1];
  assert.ok(Math.abs(cosineSimilarity(v, v) - 1.0) < 1e-9);
});

test("cosineSimilarity: orthogonal vectors → 0.0", () => {
  assert.ok(Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-9);
});

test("cosineSimilarity: opposite vectors → -1.0", () => {
  assert.ok(Math.abs(cosineSimilarity([1, 0], [-1, 0]) - (-1)) < 1e-9);
});

test("cosineSimilarity: similar non-unit vectors", () => {
  const a = [3, 4];
  const b = [6, 8];  // same direction, different magnitude
  assert.ok(Math.abs(cosineSimilarity(a, b) - 1.0) < 1e-9);
});

test("cosineSimilarity: returns 0 for empty arrays", () => {
  assert.equal(cosineSimilarity([], []), 0);
});

test("cosineSimilarity: returns 0 for null inputs", () => {
  assert.equal(cosineSimilarity(null, [1, 2]), 0);
  assert.equal(cosineSimilarity([1, 2], null), 0);
});

test("cosineSimilarity: returns 0 for mismatched lengths", () => {
  assert.equal(cosineSimilarity([1, 2], [1, 2, 3]), 0);
});

test("cosineSimilarity: result is always in [-1, 1]", () => {
  const a = [0.1, 0.5, 0.9, 0.3];
  const b = [0.8, 0.2, 0.4, 0.7];
  const sim = cosineSimilarity(a, b);
  assert.ok(sim >= -1 && sim <= 1);
});

// ── _textFromMessages ─────────────────────────────────────────────────────────

test("_textFromMessages: returns empty string for non-array input", () => {
  assert.equal(_textFromMessages(null), "");
  assert.equal(_textFromMessages("string"), "");
});

test("_textFromMessages: formats role: content pairs", () => {
  const msgs = [
    { role: "system", content: "You are helpful." },
    { role: "user",   content: "What is AI?" },
  ];
  const text = _textFromMessages(msgs);
  assert.ok(text.includes("system: You are helpful."));
  assert.ok(text.includes("user: What is AI?"));
});

test("_textFromMessages: handles array-format content", () => {
  const msgs = [{ role: "user", content: [{ type: "text", text: "Hello" }, { type: "image_url", url: "x" }] }];
  const text = _textFromMessages(msgs);
  assert.ok(text.includes("Hello"));
  assert.ok(!text.includes("image_url"));
});

test("_textFromMessages: handles missing content gracefully", () => {
  const msgs = [{ role: "user" }];
  assert.doesNotThrow(() => _textFromMessages(msgs));
});

test("_textFromMessages: truncates at 8000 chars", () => {
  const longContent = "x".repeat(9000);
  const msgs = [{ role: "user", content: longContent }];
  const text = _textFromMessages(msgs);
  assert.ok(text.length <= 8000);
});

// ── clear / size ──────────────────────────────────────────────────────────────

test("clear and size: clear wipes the store", () => {
  clear(); // ensure clean slate
  assert.equal(size(), 0);
});

test("size: returns a number", () => {
  assert.equal(typeof size(), "number");
});
