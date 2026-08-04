"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { normalizeMessages } = require("../../src/gateway/normalizeMessages");

test("a bare string becomes a single user message", () => {
  assert.deepEqual(normalizeMessages("Summarise this ticket"), [
    { role: "user", content: "Summarise this ticket" },
  ]);
});

test("an existing array passes through unchanged", () => {
  const msgs = [{ role: "system", content: "be terse" }, { role: "user", content: "hi" }];
  assert.equal(normalizeMessages(msgs), msgs); // same reference, untouched
});

test("non-string / non-array shapes pass through so validation still rejects them", () => {
  assert.equal(normalizeMessages(undefined), undefined);
  assert.equal(normalizeMessages(null), null);
  const obj = { role: "user" };
  assert.equal(normalizeMessages(obj), obj);
});
