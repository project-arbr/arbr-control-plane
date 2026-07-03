"use strict";
const { test } = require("node:test");
const assert = require("assert/strict");
const { check, maskPii } = require("../../src/gateway/outputGuardrail");

// ── check() ──────────────────────────────────────────────────────────────────

test("check: returns blocked:false when no rules", () => {
  assert.deepEqual(check("hello", []), { blocked: false });
});

test("check: returns blocked:false when text is empty", () => {
  assert.deepEqual(check("", [{ name: "r", pattern: "secret" }]), { blocked: false });
});

test("check: global rule (*) blocks matching text", () => {
  const result = check("this contains secret info", [{ name: "no-secret", pattern: "secret", application: "*" }]);
  assert.equal(result.blocked, true);
  assert.equal(result.ruleName, "no-secret");
});

test("check: global rule with no application field blocks matching text", () => {
  const result = check("confidential data here", [{ name: "conf", pattern: "confidential" }]);
  assert.equal(result.blocked, true);
  assert.equal(result.ruleName, "conf");
});

test("check: app-scoped rule blocks when application matches", () => {
  const rules = [{ name: "rule1", pattern: "blocked", application: "my-app" }];
  const result = check("this is blocked", rules, "my-app");
  assert.equal(result.blocked, true);
});

test("check: app-scoped rule is skipped when application does not match", () => {
  const rules = [{ name: "rule1", pattern: "blocked", application: "other-app" }];
  const result = check("this is blocked", rules, "my-app");
  assert.equal(result.blocked, false);
});

test("check: returns ruleName fallback to pattern when name is missing", () => {
  const result = check("hello world", [{ pattern: "world" }]);
  assert.equal(result.blocked, true);
  assert.equal(result.ruleName, "world");
});

test("check: invalid regex is silently skipped and does not throw", () => {
  const rules = [
    { name: "bad", pattern: "[unclosed" },
    { name: "good", pattern: "target" },
  ];
  const result = check("has target", rules);
  assert.equal(result.blocked, true);
  assert.equal(result.ruleName, "good");
});

test("check: regex is case-insensitive", () => {
  const result = check("Contains OPENAI reference", [{ name: "no-oi", pattern: "openai" }]);
  assert.equal(result.blocked, true);
});

test("check: returns blocked:false when no rule matches", () => {
  const result = check("safe response text", [{ name: "r", pattern: "danger" }]);
  assert.deepEqual(result, { blocked: false });
});

test("check: stops at first matching rule", () => {
  const rules = [
    { name: "first",  pattern: "alpha" },
    { name: "second", pattern: "beta" },
  ];
  const result = check("alpha and beta", rules);
  assert.equal(result.ruleName, "first");
});

// ── maskPii() ─────────────────────────────────────────────────────────────────

test("maskPii: is exported and is a function", () => {
  assert.equal(typeof maskPii, "function");
});

test("maskPii: returns a string", () => {
  const out = maskPii("email me at test@example.com");
  assert.equal(typeof out, "string");
});

test("maskPii: redacts email addresses", () => {
  const out = maskPii("contact user@example.com today");
  assert.ok(!out.includes("user@example.com"), `Expected email to be masked, got: ${out}`);
});
