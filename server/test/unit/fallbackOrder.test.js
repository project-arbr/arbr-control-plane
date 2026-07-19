"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildFallbackOrder } = require("../../src/gateway/handler");

const defaults = {
  openai: "gpt-4o-mini",
  anthropic: "claude-haiku-4-5",
  gemini: "gemini-2.5-flash",
};

test("same-provider retries default model on same provider only", () => {
  const order = buildFallbackOrder("openai", "gpt-4o", ["openai", "anthropic"], defaults, "same-provider");
  assert.deepEqual(order, [
    { provider: "openai", model: "gpt-4o" },
    { provider: "openai", model: "gpt-4o-mini" },
  ]);
});

test("same-provider is primary-only when already on default model", () => {
  const order = buildFallbackOrder("openai", "gpt-4o-mini", ["openai", "anthropic"], defaults, "same-provider");
  assert.deepEqual(order, [{ provider: "openai", model: "gpt-4o-mini" }]);
});

test("cross-provider walks remaining live providers", () => {
  const order = buildFallbackOrder("openai", "gpt-4o", ["openai", "anthropic", "gemini"], defaults, "cross-provider");
  assert.equal(order[0].provider, "openai");
  assert.equal(order.length, 3);
  assert.ok(order.some((x) => x.provider === "anthropic"));
  assert.ok(order.some((x) => x.provider === "gemini"));
});

test("none never falls back", () => {
  const order = buildFallbackOrder("openai", "gpt-4o", ["openai", "anthropic"], defaults, "none");
  assert.deepEqual(order, [{ provider: "openai", model: "gpt-4o" }]);
});
