"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { csvCell } = require("../../src/utils/csv");

test("plain string returned as-is", () => {
  assert.equal(csvCell("hello"), "hello");
});

test("string with comma is quoted", () => {
  assert.equal(csvCell("a,b"), '"a,b"');
});

test("string with double-quote is escaped", () => {
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
});

test("string with newline is quoted", () => {
  assert.equal(csvCell("line1\nline2"), '"line1\nline2"');
});

test("null returns empty string", () => {
  assert.equal(csvCell(null), "");
});

test("undefined returns empty string", () => {
  assert.equal(csvCell(undefined), "");
});

test("Date returns ISO string", () => {
  const d = new Date("2024-01-15T10:00:00.000Z");
  assert.equal(csvCell(d), "2024-01-15T10:00:00.000Z");
});

test("number returns string representation", () => {
  assert.equal(csvCell(42), "42");
  assert.equal(csvCell(3.14), "3.14");
});
