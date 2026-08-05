"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { extractUsage, extractFinishReason } = require("../../src/providers/llm-router");

// Reasoning/"thinking" tokens count toward total but not output_tokens — the reason a thinking
// model can return total > input+output with an empty answer. Surfacing them makes that visible.
test("reasoningTokens surfaced from LangChain output_token_details (Gemini thinking)", () => {
  // Mirrors the reported case: 6 in, 0 visible out, 16 reasoning, 22 total.
  const u = extractUsage({
    usage_metadata: {
      input_tokens: 6,
      output_tokens: 0,
      total_tokens: 22,
      output_token_details: { reasoning: 16 },
    },
  });
  assert.equal(u.inputTokens, 6);
  assert.equal(u.outputTokens, 0);
  assert.equal(u.totalTokens, 22);
  assert.equal(u.reasoningTokens, 16);
});

test("reasoningTokens surfaced from raw OpenAI completion_tokens_details", () => {
  const u = extractUsage({
    response_metadata: { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 40,
      completion_tokens_details: { reasoning_tokens: 25 } } },
  });
  assert.equal(u.reasoningTokens, 25);
});

test("reasoningTokens omitted entirely when the provider does not report it", () => {
  const u = extractUsage({ usage_metadata: { input_tokens: 6, output_tokens: 4, total_tokens: 10 } });
  assert.ok(!("reasoningTokens" in u), "no reasoning field when absent");
});

test("Gemini MAX_TOKENS maps to finish_reason 'length'", () => {
  assert.equal(extractFinishReason({ response_metadata: { finishReason: "MAX_TOKENS" } }), "length");
});
