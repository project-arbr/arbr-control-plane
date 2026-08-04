"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const pricing = require("../../src/pricing/registry");
const { supportsTools } = require("../../src/gateway/capabilities");

// toolCallSupported must reflect what /v1/chat/completions can actually route, not the raw
// model capability. The endpoint only has a tool path for OpenAI-compatible providers and
// bedrock-nova; anything else (gemini) returns 501, so the flag must be false there.

test("tools true for OpenAI-compat providers", () => {
  for (const p of ["openai", "deepseek", "moonshot", "xai", "groq", "litellm"]) {
    assert.equal(supportsTools(p, "some-chat-model"), true, `${p} should support tools`);
  }
});

test("tools FALSE for gemini even when the model is function-calling capable", () => {
  // The reported bug: gemini-2.5-flash reports supportsFunctionCalling upstream, but the
  // endpoint has no tool path for gemini, so the flag must not advertise it.
  const orig = pricing.getModel;
  pricing.getModel = () => ({ supportsFunctionCalling: true, provider: "gemini" });
  try {
    assert.equal(supportsTools("gemini", "gemini-2.5-flash"), false);
  } finally {
    pricing.getModel = orig;
  }
});

test("tools false for other native providers (anthropic, plain bedrock)", () => {
  assert.equal(supportsTools("anthropic", "claude-sonnet-4-5"), false);
  assert.equal(supportsTools("bedrock", "anthropic.claude-3-5-sonnet"), false);
});

test("bedrock-nova gates tools by model pattern", () => {
  assert.equal(supportsTools("bedrock-nova", "us.amazon.nova-pro-v1:0"), true);
  assert.equal(supportsTools("bedrock-nova", "anthropic.claude-3-5-sonnet"), true);
  assert.equal(supportsTools("bedrock-nova", "mistral.mistral-7b-instruct"), false);
});

test("an explicit not-capable flag on a compat provider is respected", () => {
  const orig = pricing.getModel;
  pricing.getModel = () => ({ supportsFunctionCalling: false });
  try {
    assert.equal(supportsTools("openai", "text-only-legacy-model"), false);
  } finally {
    pricing.getModel = orig;
  }
});
