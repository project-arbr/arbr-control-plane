"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { getPromptPair } = require("../../src/seed/promptPacks");

test("getPromptPair returns a prompt/response pair for a known task type", () => {
  const p = getPromptPair("classification", 0);
  assert.ok(p.prompt && typeof p.prompt === "string");
  assert.ok(p.response && typeof p.response === "string");
});

test("getPromptPair cycles within a pack and falls back for unknown types", () => {
  const p = getPromptPair("extraction", 5); // index wraps
  assert.ok(p.prompt.includes("JSON")); // extraction pack is structured
  const g = getPromptPair("totally-unknown-task", 0);
  assert.ok(g.prompt && g.response); // generic fallback
});

test("extraction responses are valid JSON (drives the structured-output demo)", () => {
  const p = getPromptPair("extraction", 0);
  assert.doesNotThrow(() => JSON.parse(p.response));
});
