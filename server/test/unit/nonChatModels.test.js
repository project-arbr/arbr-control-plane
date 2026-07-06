"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { isChatLikelyModelId } = require("../../src/providers/importLogic");

// Media / non-chat ids that a provider catalog lists but which 404 on /chat/completions and
// must never be routed to. The Lyria case is the regression this fix closes: Gemini's music
// model was registered as a light-tier $0 "chat" model and got auto-assigned to an extraction task.
test("non-chat model ids are flagged not-chat-capable", () => {
  for (const id of [
    "lyria-3-pro-preview", "lyria-3-clip-preview",   // music (the prod misroute)
    "imagen-3.0-generate", "veo-2.0", "dall-e-3", "dalle-3",
    "musicgen-large", "audiogen-medium", "sora",
    "text-embedding-3-large", "cohere-rerank-v3", "whisper-large-v3",
    "gemini-diffusion", "stable-audio-2",
  ]) {
    assert.equal(isChatLikelyModelId(id), false, `${id} should be non-chat`);
  }
});

// Real chat models — including ones whose ids brush up against the media patterns — stay routable.
test("genuine chat model ids remain chat-capable", () => {
  for (const id of [
    "gpt-4o-mini", "claude-haiku-4-5", "gemini-2.5-flash-lite",
    "deepseek-chat", "us.deepseek.r1-v1:0", "grok-3-mini",
    "llama-3.1-8b-instant", "us.amazon.nova-lite-v1:0", "moonshot-v1-8k",
  ]) {
    assert.equal(isChatLikelyModelId(id), true, `${id} should stay chat-capable`);
  }
});
